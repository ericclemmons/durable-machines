import { Schema } from "effect";
import { setup } from "xstate";
import { standardSchemaValidator } from "xstate/validation";
import { OutboxFailed, ScmEvent, std } from "../domain/scm";

export const InstallationInput = Schema.Struct({
  installationId: Schema.String,
  owner: Schema.String,
  /** Repo → Cloudflare accounts that connected it. One repo can fan out to many. */
  repos: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** Whether the org has the GitHub App installed when the object first starts. */
  installed: Schema.Boolean,
});

const Route = Schema.Struct({
  deliveryId: Schema.String,
  repo: Schema.String,
  summary: Schema.String,
  accounts: Schema.Array(Schema.String),
  dropped: Schema.NullOr(Schema.String),
});

const InstallationContext = Schema.Struct({
  ...InstallationInput.fields,
  routes: Schema.Array(Route),
  /** When the installation access token expires. GitHub mints them for an hour. */
  tokenExpiresAt: Schema.NullOr(Schema.Number),
});
type InstallationContext = typeof InstallationContext.Type;

const TOKEN_TTL = 60 * 60_000;

const summarize = (event: ScmEvent) => (event.kind === "push" ? `push ${event.branch}` : `pull_request.${event.action} #${event.number}`);

const route = (context: InstallationContext, event: ScmEvent, accounts: string[], dropped: string | null) => ({
  ...context,
  routes: [...context.routes, { deliveryId: event.deliveryId, repo: event.repo, summary: summarize(event), accounts, dropped }].slice(-10),
});

const accountsFor = (context: InstallationContext, event: ScmEvent) => [...(context.repos[event.repo.toLowerCase()] ?? [])];

/**
 * One GitHub App installation. It is the only thing that knows which Cloudflare
 * accounts use a repo, so it fans each SCM event out to those Account objects.
 *
 * It follows the App's lifecycle on GitHub: installed (active or suspended by
 * the org) and uninstalled, and installed again. While active it holds an
 * installation access token: minted on the first event, valid for an hour,
 * then refreshed by the next event.
 */
export const installationMachine = setup({
  validator: standardSchemaValidator(),
  actions: {
    toAccount: (_message: { accountId: string; event: ScmEvent }) => {},
  },
  schemas: {
    input: std(InstallationInput),
    context: std(InstallationContext),
    events: {
      "scm.event": std(Schema.Struct({ event: ScmEvent })),
      "installation.created": std(Schema.Struct({})),
      "installation.deleted": std(Schema.Struct({})),
      "installation.suspended": std(Schema.Struct({})),
      "installation.unsuspended": std(Schema.Struct({})),
      "outbox.failed": std(OutboxFailed),
    },
  },
}).createMachine({
  id: "installation",
  version: "2",
  context: ({ input }) => ({ ...input, routes: [], tokenExpiresAt: null }),
  initial: "pending",
  states: {
    pending: {
      type: "choice",
      choice: ({ context }) => (context.installed ? { target: "installed" } : { target: "not_installed" }),
    },
    not_installed: {
      description: "The org hasn't installed the GitHub App; events are dropped",
      on: {
        "scm.event": ({ context, event }) => ({ context: route(context, event.event, [], "GitHub App not installed") }),
        "installation.created": { target: "installed" },
      },
    },
    installed: {
      initial: "active",
      states: {
        active: {
          description: "Routes SCM events to every connected account",
          initial: "no_token",
          states: {
            no_token: {
              description: "No installation access token yet",
              on: {
                "scm.event": ({ context, event, actions }, enq) => {
                  const accounts = accountsFor(context, event.event);
                  for (const accountId of accounts) enq(actions.toAccount, { accountId, event: event.event });
                  const next = { ...context, tokenExpiresAt: event.event.receivedAt + TOKEN_TTL };
                  return { target: "token_valid", context: route(next, event.event, accounts, accounts.length ? null : "No account uses this repo") };
                },
              },
            },
            token_valid: {
              description: "Access token minted; GitHub expires it after an hour",
              timeout: TOKEN_TTL,
              onTimeout: { target: "token_expired" },
              on: {
                "scm.event": ({ context, event, actions }, enq) => {
                  const accounts = accountsFor(context, event.event);
                  for (const accountId of accounts) enq(actions.toAccount, { accountId, event: event.event });
                  return { context: route(context, event.event, accounts, accounts.length ? null : "No account uses this repo") };
                },
              },
            },
            token_expired: {
              description: "The next event refreshes the token",
              on: {
                "scm.event": ({ context, event, actions }, enq) => {
                  const accounts = accountsFor(context, event.event);
                  for (const accountId of accounts) enq(actions.toAccount, { accountId, event: event.event });
                  const next = { ...context, tokenExpiresAt: event.event.receivedAt + TOKEN_TTL };
                  return { target: "token_valid", context: route(next, event.event, accounts, accounts.length ? null : "No account uses this repo") };
                },
              },
            },
          },
          on: {
            "installation.suspended": ({ context }) => ({ target: "suspended", context: { ...context, tokenExpiresAt: null } }),
          },
        },
        suspended: {
          description: "The org suspended the GitHub App; its tokens are revoked and events are dropped",
          on: {
            "scm.event": ({ context, event }) => ({ context: route(context, event.event, [], "Installation suspended") }),
            "installation.unsuspended": { target: "active" },
          },
        },
      },
      on: {
        "installation.deleted": ({ context }) => ({ target: "uninstalled", context: { ...context, tokenExpiresAt: null } }),
      },
    },
    uninstalled: {
      description: "The org uninstalled the GitHub App; events are dropped until it's installed again",
      on: {
        "scm.event": ({ context, event }) => ({ context: route(context, event.event, [], "GitHub App uninstalled") }),
        "installation.created": { target: "installed" },
      },
    },
  },
});
