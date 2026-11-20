import { Text } from "@cloudflare/kumo";
import { CubeIcon, type Icon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { lineDiff } from "./diff";

/** What the app knows about one kind of object ("Account"): its icon, display name and what it's for. */
export type ObjectKind = {
  icon?: Icon;
  name?: string;
  purpose?: string;
  /** How to show an object's name as its `#id` ("free-web-3" → "3"). Defaults to the name. */
  id?: (name: string) => string;
};

let kinds: Readonly<Record<string, ObjectKind>> = {};

/** Tell the inspector about the app's kinds of object, keyed by class ("Account") or address ("Webhook Worker"). Call once at startup. */
export function registerObjects(objects: Record<string, ObjectKind>) {
  kinds = { ...kinds, ...objects };
}

/** An address ("Account/alice") as the parts a label shows. */
export function objectOf(address: string) {
  const [kind = address, ...rest] = address.split("/");
  const known = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
  const name = rest.join("/");
  return { kind, id: name && known?.id ? known.id(name) : name, name: known?.name ?? kind, icon: known?.icon ?? CubeIcon, purpose: known?.purpose };
}

/** The label text, for measuring. */
export const objectLabelText = (address: string) => {
  const { name, id } = objectOf(address);
  return id ? `${name} #${id}` : name;
};

export const objectPurpose = (address: string) => objectOf(address).purpose;

/**
 * A Durable Object (or Workflow): icon, name, then its id as `#id`. `spread`
 * pushes the id to the right edge. Without the kind, it's the icon and id.
 */
export function ObjectLabel({
  address,
  showKind = true,
  spread = false,
  className = "",
}: {
  address: string;
  showKind?: boolean;
  spread?: boolean;
  className?: string;
}) {
  const { kind, id, name, icon: Icon } = objectOf(address);
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${spread ? "w-full" : ""} ${className}`}>
      <Icon className="shrink-0" aria-label={showKind ? undefined : kind} aria-hidden={showKind} />
      {showKind && <span className="truncate">{name}</span>}
      {id &&
        (showKind ? (
          <code className={`shrink-0 font-mono text-[0.9em] leading-none font-normal text-kumo-subtle ${spread ? "ml-auto pl-2" : ""}`}>#{id}</code>
        ) : (
          <code className="truncate font-mono text-[0.9em] text-kumo-strong">{id}</code>
        ))}
    </span>
  );
}

export type NoticeValue = { ok: boolean; text: string };

export function Notice({ value }: { value?: NoticeValue }) {
  if (!value) return null;
  return (
    <p className={`rounded-md px-3 py-2 font-mono text-xs ${value.ok ? "bg-emerald-500/10 text-emerald-700" : "bg-red-500/10 text-red-700"}`}>
      {value.ok ? "✓ " : "✗ rejected: "}
      {value.text}
    </p>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const tokenClass = (token: string) =>
  token.endsWith(":") ? "text-sky-800" : token.startsWith('"') ? "text-emerald-700" : /^[tfn]/.test(token) ? "text-purple-700" : "text-orange-700";

/** Highlight one piece of pretty-printed JSON text. */
export function highlightJson(text: string) {
  return text.split(JSON_TOKEN).map((part, i) =>
    i % 2 ? (
      <span key={i} className={tokenClass(part)}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/** JSON, pretty-printed and highlighted. Light enough for every row of a long list. */
export function JsonView({ value, className = "" }: { value: unknown; className?: string }) {
  return <pre className={`overflow-auto font-mono text-xs leading-4 text-kumo-default ${className}`}>{highlightJson(JSON.stringify(value, null, 2))}</pre>;
}

/** The state as JSON, with what the event changed: removed lines in red, added lines in green. Scrolls to the first change. */
export function JsonDiff({ before, after }: { before: unknown; after: unknown }) {
  const lines = lineDiff(JSON.stringify(before, null, 2).split("\n"), JSON.stringify(after, null, 2).split("\n"));
  const changed = lines.filter((l) => l.op !== " ").length;
  const first = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(after);
  useEffect(() => {
    first.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [key]);
  let marked = false;
  return (
    <div className="grid gap-1">
      <Text size="xs" variant="secondary">
        {changed
          ? `What this event changed: ${lines.filter((l) => l.op === "-").length} lines removed, ${lines.filter((l) => l.op === "+").length} added.`
          : "This event changed nothing in the state."}
      </Text>
      <pre className="overflow-auto rounded-lg bg-kumo-elevated py-2 font-mono text-xs leading-5 ring ring-kumo-line">
        {lines.map((l, i) => {
          const ref = l.op !== " " && !marked ? ((marked = true), first) : undefined;
          return (
            <div key={i} ref={ref} className={`px-3 ${l.op === "+" ? "bg-emerald-500/15" : l.op === "-" ? "bg-red-500/15 text-kumo-subtle" : ""}`}>
              <span className={`mr-2 inline-block w-3 select-none ${l.op === "+" ? "text-emerald-700" : l.op === "-" ? "text-red-700" : "text-kumo-inactive"}`}>
                {l.op}
              </span>
              {highlightJson(l.text)}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
