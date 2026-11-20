import { Button, Input, Popover, Select, Tabs, Text, Tooltip } from "@cloudflare/kumo";
import { BuildingsIcon, GearSixIcon, GitPullRequestIcon, GithubLogoIcon, InfoIcon, PauseIcon, PlayIcon, SpeedometerIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Simulation } from "../domain/github";
import type { IngestResult } from "../worker/webhook";
import { BuildSettingsForm } from "./BuildSettings";
import { sendTo, setHovered, setPinned, setSelectedNode, setSending, useClock, useInFlight, useView } from "@durable-machines/inspector";
import { busy } from "./builds";
import type { ProjectContext, ProjectRecord, ProjectSettings } from "./types";

type SimResult = IngestResult & { githubEvent: string; deliveryId: string; payload: unknown };
type Scenario = { group: string; label: string; hint: string; run: () => Promise<unknown> };

let prCounter = 40 + Math.floor(Math.random() * 40);

const SPEEDS = [
  [0, "Instant"],
  [250, "0.25 s"],
  [500, "0.5 s"],
  [1000, "1 s"],
  [2000, "2 s"],
  [4000, "4 s"],
] as const;

function logResult(result: SimResult) {
  const head = `%cwebhook%c ${result.githubEvent} ${result.ok ? "✓" : "✗"} ${result.trace.at(-1)?.detail ?? ""}`;
  console.groupCollapsed(head, "color:#71717a", result.ok ? "color:#059669" : "color:#dc2626");
  for (const t of result.trace) console.log(`${t.ok ? "✓" : "✗"} ${t.step}: ${t.detail}`);
  console.log("payload", result.payload);
  console.groupEnd();
}

/**
 * The GitHub side of the demo, at the top of the right-hand panel. Pick a scenario, then
 * drive it with the transport controls: ▶ plays (sending the scenario first
 * when nothing is moving), ⏸ pauses, ⏩ runs one hop, ⏭ runs until the next
 * machine. Paused is the default, so a scenario steps.
 */
export function Simulator({
  projects,
  accounts,
  accountId,
  onAccount,
}: {
  projects: ProjectRecord[];
  accounts: Array<{ id: string; name: string }>;
  accountId: string;
  onAccount: (id: string) => void;
}) {
  // You pick a repository, as on GitHub. Which Project it reaches is the system's job;
  // the Build settings follow this account's Project for that repository.
  const repos = [...new Set(projects.map((p) => p.repo))];
  const [repo, setRepo] = useState(repos[0] ?? "");
  const project = projects.find((p) => p.repo === repo) ?? projects[0]!;
  const projectView = useView("Project", project.id);
  const [branch, setBranch] = useState("feature/new-nav");
  const [message, setMessage] = useState("Add the new navigation");
  const [prNumber, setPrNumber] = useState(prCounter);
  const [results, setResults] = useState<SimResult[]>([]);
  const [choice, setChoice] = useState(0);
  const savedSettings = useRef<Record<string, ProjectSettings>>({});
  const clock = useClock();
  const inFlight = useInFlight(busy);

  useEffect(() => {
    if (!projects.some((p) => p.repo === repo)) setRepo(projects[0]?.repo ?? "");
  }, [projects, repo]);

  const post = async (body: unknown) => {
    const response = await fetch("/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = (await response.json()) as SimResult;
    logResult(result);
    setResults((r) => [result, ...r].slice(0, 6));
    return result;
  };
  const fire = (sim: Omit<Simulation, "repo"> & { repo?: string }) => post({ repo: project.repo, ...sim });
  const chaos = (mode: "overloaded" | "retryable", seconds: number) =>
    fetch("/api/chaos", { method: "POST", body: JSON.stringify({ target: `Project/${project.id}`, mode, seconds }) });

  const prod = project.productionBranch;
  const scenarios: Scenario[] = [
    {
      group: "Pushes",
      label: "Push to production",
      hint: `push → ${prod}`,
      run: () => fire({ scenario: "push", branch: prod, message: "Update homepage copy", prNumber }),
    },
    {
      group: "Pushes",
      label: "Push to the PR branch",
      hint: `Opens PR #${prNumber}, then pushes ${branch}`,
      run: async () => {
        await fire({ scenario: "pr_opened", branch, message, prNumber });
        await fire({ scenario: "push", branch, message: "Address review comments", prNumber });
      },
    },
    {
      group: "Pushes",
      label: "Push without a PR",
      hint: "Ignored: the branch has no open PR",
      run: () => fire({ scenario: "push", branch: `spike/${Date.now() % 1000}`, message: "Try something", prNumber }),
    },
    {
      group: "Pushes",
      label: "Burst ×4 to production",
      hint: "Queueing, concurrency and supersede",
      run: async () => {
        for (const n of [1, 2, 3, 4]) await fire({ scenario: "push", branch: prod, message: `Hotfix ${n}`, prNumber });
      },
    },
    {
      group: "Pull requests",
      label: "Open a PR",
      hint: `pull_request.opened #${prNumber} on ${branch}`,
      run: () => fire({ scenario: "pr_opened", branch, message, prNumber }),
    },
    {
      group: "Pull requests",
      label: "Close the PR",
      hint: "Opens the PR, closes it, then pushes the branch: that push doesn't build",
      run: async () => {
        await fire({ scenario: "pr_opened", branch, message, prNumber });
        await fire({ scenario: "pr_closed", branch, message, prNumber });
        await fire({ scenario: "push", branch, message: "Push after closing", prNumber });
      },
    },
    {
      group: "Pull requests",
      label: "Merge the PR",
      hint: "Opens the PR, merges it (closing it), then pushes production",
      run: async () => {
        await fire({ scenario: "pr_opened", branch, message, prNumber });
        await fire({ scenario: "pr_merged", branch, message, prNumber });
        await fire({ scenario: "push", branch: prod, message: `Merge pull request #${prNumber}`, prNumber });
        prCounter++;
        setPrNumber(prCounter);
        setBranch(`feature/${["search", "billing", "dark-mode", "i18n", "perf"][prCounter % 5]}`);
      },
    },
    {
      group: "Forks",
      label: "Open a fork PR",
      hint: "The build waits for a maintainer's approval",
      run: () => fire({ scenario: "fork_pr_opened", branch: "patch-1", message: "Fix a typo", prNumber: prNumber + 100 }),
    },
    {
      group: "Forks",
      label: "Push to the fork PR",
      hint: "Opens a fork PR, then pull_request.synchronize supersedes its waiting build",
      run: async () => {
        await fire({ scenario: "fork_pr_opened", branch: "patch-1", message: "Fix a typo", prNumber: prNumber + 100 });
        await fire({ scenario: "fork_pr_synchronize", branch: "patch-1", message: "Fix another typo", prNumber: prNumber + 100 });
      },
    },
    {
      group: "Failures",
      label: "Failing build",
      hint: '"[fail]" in the commit message fails the build step',
      run: () => fire({ scenario: "push", branch: prod, message: "[fail] Break the build", prNumber }),
    },
    {
      group: "Failures",
      label: "Bad signature",
      hint: "Stops at signature verification",
      run: () => fire({ scenario: "push", branch: prod, message: "Forged", prNumber, tamper: true }),
    },
    {
      group: "Failures",
      label: "Unknown repo",
      hint: "Stops when resolving the repository",
      run: () => fire({ repo: "acme/unknown", scenario: "push", branch: "main", message: "Hi", prNumber }),
    },
    {
      group: "Failures",
      label: "Redeliver a webhook",
      hint: "Pushes production, then GitHub redelivers it: same X-GitHub-Delivery, so it's deduplicated",
      run: async () => {
        const first = await fire({ scenario: "push", branch: prod, message: "Update homepage copy", prNumber });
        await post({ replay: { githubEvent: first.githubEvent, deliveryId: first.deliveryId, payload: first.payload } });
      },
    },
    {
      group: "Durable Object faults",
      label: `Overload Project/${project.id}`,
      hint: "10 s of .overloaded errors, then a push",
      run: async () => {
        await chaos("overloaded", 10);
        await fire({ scenario: "push", branch: prod, message: "Pushed while overloaded", prNumber });
      },
    },
    {
      group: "Durable Object faults",
      label: "Flaky network",
      hint: "8 s of .retryable errors, then a push",
      run: async () => {
        await chaos("retryable", 8);
        await fire({ scenario: "push", branch: prod, message: "Pushed on a flaky network", prNumber });
      },
    },
    {
      group: "Installation",
      label: "Suspend the GitHub App",
      hint: "installation.suspend, then a push: it's dropped",
      run: async () => {
        await fire({ scenario: "installation_suspend", branch: "", message: "", prNumber });
        await fire({ scenario: "push", branch: prod, message: "Pushed while suspended", prNumber });
      },
    },
    {
      group: "Installation",
      label: "Unsuspend the GitHub App",
      hint: "Suspends the app, installation.unsuspend, then a push builds",
      run: async () => {
        await fire({ scenario: "installation_suspend", branch: "", message: "", prNumber });
        await fire({ scenario: "installation_unsuspend", branch: "", message: "", prNumber });
        await fire({ scenario: "push", branch: prod, message: "Pushed after unsuspending", prNumber });
      },
    },
    {
      group: "Installation",
      label: "Uninstall the GitHub App",
      hint: "installation.deleted, then a push: it's dropped",
      run: async () => {
        await fire({ scenario: "installation_deleted", branch: "", message: "", prNumber });
        await fire({ scenario: "push", branch: prod, message: "Pushed after uninstalling", prNumber });
      },
    },
    {
      group: "Installation",
      label: "Reinstall the GitHub App",
      hint: "Uninstalls, installs again (installation.created), then a push builds",
      run: async () => {
        await fire({ scenario: "installation_deleted", branch: "", message: "", prNumber });
        await fire({ scenario: "installation_created", branch: "", message: "", prNumber });
        await fire({ scenario: "push", branch: prod, message: "Pushed after reinstalling", prNumber });
      },
    },
  ];
  const groups = [...new Set(scenarios.map((s) => s.group))];
  const selected = scenarios[choice] ?? scenarios[0]!;
  const [latest] = results;
  const [head] = clock.parked;

  // Every run starts from a clean system. Build settings you saved are applied again.
  const fresh = async () => {
    setPinned(undefined);
    setHovered(undefined);
    setResults([]);
    setSelectedNode(undefined);
    await fetch("/api/reset", { method: "POST" });
    for (const [id, saved] of Object.entries(savedSettings.current)) await sendTo(`Project/${id}`, { type: "settings.update", settings: saved });
  };

  // The scenario the current run is for. Pick another one and the controls start it afresh.
  const ran = useRef<string>(undefined);
  const runKey = `${repo}|${choice}`;
  const send = async () => {
    ran.current = runKey;
    setSending(true);
    try {
      await fresh();
      await selected.run();
    } finally {
      setSending(false);
    }
  };

  // Nothing moving, or another scenario picked: the transport controls reset and start the selected one.
  const playedHere = useRef(false);
  const stale = ran.current !== runKey;
  const play = async () => {
    playedHere.current = true;
    if (!inFlight || stale) await send();
    await clock.call("play");
  };
  const step = async (method: "next" | "nextMachine") => {
    if (!clock.playing && ((!inFlight && !head) || stale)) return send();
    await clock.call(method);
  };

  // Play turns itself off once the scenario has run: nothing left moving for a moment.
  // Only the tab that pressed play does this; another tab may watch a different account.
  const wasMoving = useRef(false);
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (wasPlaying.current && !clock.playing) playedHere.current = false;
    wasPlaying.current = clock.playing;
    if (!clock.playing) return void (wasMoving.current = false);
    if (!playedHere.current) return;
    if (inFlight) return void (wasMoving.current = true);
    if (!wasMoving.current) return;
    const timer = setTimeout(() => void clock.call("pause"), 1500);
    return () => clearTimeout(timer);
  }, [clock.playing, inFlight, clock]);

  // Manual: ▶ runs one hop. A speed: ▶ plays at that pace, ⏸ pauses.
  const [speed, setSpeed] = useState<Speed>(() => {
    const saved = localStorage.getItem("speed");
    return saved === "manual" ? "manual" : saved !== null && SPEEDS.some(([ms]) => String(ms) === saved) ? Number(saved) : 500;
  });
  useEffect(() => localStorage.setItem("speed", String(speed)), [speed]);
  const changeSpeed = async (next: Speed) => {
    setSpeed(next);
    if (next === "manual") await clock.call("pause");
    else await clock.call("setPace", [next]);
  };
  const press = async () => {
    if (speed === "manual") {
      if (clock.playing) await clock.call("pause");
      return step("next");
    }
    if (clock.playing) return clock.call("pause");
    if (clock.pace !== speed) await clock.call("setPace", [speed]);
    return play();
  };
  const manual = speed === "manual";
  const pressLabel = manual
    ? (inFlight || head) && !stale
      ? "Next hop"
      : `Reset, then step through "${selected.label}"`
    : clock.playing
      ? "Pause"
      : inFlight && !stale
        ? "Play"
        : `Reset, then play "${selected.label}"`;

  const settings = (projectView.view?.root.context as unknown as ProjectContext | undefined)?.settings;

  return (
    <div className="grid gap-2 border-t border-kumo-line bg-kumo-base px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
        <InfoIcon aria-hidden className="shrink-0" />
        <span className="truncate" title={selected.hint}>
          {selected.hint}
        </span>
        {latest && (
          <Popover.Root>
            <Popover.Trigger
              render={<button className={`ml-auto shrink-0 rounded px-1 hover:bg-kumo-tint ${latest.ok ? "text-kumo-success" : "text-kumo-danger"}`} />}
            >
              Webhook {latest.ok ? "✓" : "✗"}
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="top" align="end">
                <Popover.Popup className="w-[28rem]">
                  <Popover.Arrow />
                  <Popover.Title>Webhook pipeline</Popover.Title>
                  <Popover.Description>
                    <span className="font-mono text-[0.9em]">{latest.githubEvent}</span> · delivery {latest.deliveryId.slice(0, 8)}…
                  </Popover.Description>
                  <ol className="mt-3 grid gap-1 text-sm">
                    {latest.trace.map((t, i) => (
                      <li key={`${latest.deliveryId}-${i}`} className="flex gap-2">
                        <span className={t.ok ? "text-kumo-success" : "text-kumo-danger"}>{t.ok ? "✓" : "✗"}</span>
                        <span className="shrink-0">{t.step}</span>
                        <span className="truncate text-kumo-subtle">{t.detail}</span>
                      </li>
                    ))}
                  </ol>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <Select aria-label="Scenario" value={choice} onValueChange={(v) => setChoice(Number(v))} renderValue={() => selected.label} className="min-w-0 flex-1">
          {groups.map((g) => (
            <Select.Group key={g}>
              <Select.GroupLabel>{g}</Select.GroupLabel>
              {scenarios.map((s, i) =>
                s.group === g ? (
                  <Select.Option key={s.label} value={i}>
                    {s.label}
                  </Select.Option>
                ) : null,
              )}
            </Select.Group>
          ))}
        </Select>
        <Tooltip
          content={pressLabel}
          render={
            <Button
              variant="primary"
              shape="square"
              icon={!manual && clock.playing ? PauseIcon : PlayIcon}
              aria-label={pressLabel}
              onClick={() => void press()}
            />
          }
        />
        <Select
          aria-label="Speed"
          value={speed}
          onValueChange={(v) => void changeSpeed(v === "manual" ? "manual" : Number(v))}
          items={[{ label: "Manual", value: "manual" as Speed }, ...SPEEDS.map(([ms, label]) => ({ label, value: ms as Speed }))]}
          renderValue={(v) => (
            <span className="inline-flex items-center gap-1.5">
              <SpeedometerIcon aria-hidden className="shrink-0" />
              {v === "manual" ? "Manual" : (SPEEDS.find(([ms]) => ms === Number(v))?.[1] ?? String(v))}
            </span>
          )}
          className="w-28 shrink-0"
        />
        <Popover.Root>
          <Tooltip
            content="Settings"
            render={<Popover.Trigger render={<Button variant="secondary" shape="square" icon={GearSixIcon} aria-label="Settings" />} />}
          />
          <Popover.Portal>
            <Popover.Positioner side="top" align="end">
              <Popover.Popup className="max-h-[80vh] w-[24rem] overflow-y-auto">
                <Popover.Arrow />
                <div className="grid gap-4 whitespace-normal">
                  <Field icon={GithubLogoIcon} title="Repository">
                    <Select
                      aria-label="Repository"
                      value={repo}
                      onValueChange={(v) => setRepo(String(v))}
                      items={Object.fromEntries(repos.map((r) => [r, r]))}
                      className="w-full"
                    />
                  </Field>
                  <Field icon={BuildingsIcon} title="Account">
                    <div className="justify-self-start">
                      <Tabs
                        variant="segmented"
                        value={accountId}
                        onValueChange={(v) => onAccount(String(v))}
                        tabs={accounts.map((a) => ({ value: a.id, label: a.name }))}
                      />
                    </div>
                  </Field>
                  <Field icon={GitPullRequestIcon} title="GitHub event">
                    <Input label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono" />
                    <Input label="Pull request number" type="number" value={String(prNumber)} onChange={(e) => setPrNumber(Number(e.target.value))} />
                    <Input label="Title" value={message} onChange={(e) => setMessage(e.target.value)} />
                  </Field>
                  <Field icon={GearSixIcon} title="Build settings">
                    {settings && (
                      <BuildSettingsForm
                        settings={settings}
                        productionBranch={project.productionBranch}
                        onSave={async (next) => {
                          const result = await projectView.send({ type: "settings.update", settings: next });
                          if (result.ok) savedSettings.current[project.id] = next;
                          else console.error(`Project/${project.id} rejected settings.update`, result.error);
                        }}
                      />
                    )}
                  </Field>
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  );
}

type Speed = "manual" | number;

/** One group of settings in the settings popover. */
function Field({ icon: Icon, title, children }: { icon: typeof GearSixIcon; title: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <Text as="h3" size="sm" bold>
        <span className="inline-flex items-center gap-1.5">
          <Icon aria-hidden />
          {title}
        </span>
      </Text>
      {children}
    </section>
  );
}
