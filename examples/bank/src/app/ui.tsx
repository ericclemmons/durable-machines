import { ArrowsLeftRightIcon, BankIcon, CloudIcon, CubeIcon, WalletIcon } from "@phosphor-icons/react";

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

/** Each kind of object: its icon, display name and what it's for. */
export const OBJECTS = {
  Account: { icon: WalletIcon, name: "Account", purpose: "One per visitor: holds the balance and sets money aside for transfers" },
  Transfer: { icon: ArrowsLeftRightIcon, name: "Transfer", purpose: "One per transfer: the saga that moves the money" },
  Bank: { icon: BankIcon, name: "Bank", purpose: "The clearing house every visitor shares: one transfer at a time" },
  Worker: { icon: CloudIcon, name: "Worker", purpose: "Takes your commands" },
} as const;

const objectOf = (address: string) => {
  const [kind = address, ...rest] = address.split("/");
  const known = OBJECTS[kind as keyof typeof OBJECTS];
  return { kind, id: rest.join("/"), name: known?.name ?? kind, icon: known?.icon ?? CubeIcon, purpose: known?.purpose };
};

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
          <code className={`shrink-0 font-mono text-[0.9em] font-normal text-kumo-subtle ${spread ? "ml-auto pl-2" : ""}`}>#{id}</code>
        ) : (
          <code className="truncate font-mono text-[0.9em] text-kumo-strong">{id}</code>
        ))}
    </span>
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
  const parts = JSON.stringify(value, null, 2).split(JSON_TOKEN);
  return (
    <pre className={`overflow-auto font-mono text-xs leading-4 text-kumo-default ${className}`}>
      {parts.map((part, i) =>
        i % 2 ? (
          <span key={i} className={tokenClass(part)}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </pre>
  );
}
