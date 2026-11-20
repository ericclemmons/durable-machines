import { Badge, Button, Select, Text } from "@cloudflare/kumo";
import { ArrowDownIcon, ArrowUpIcon, PaperPlaneTiltIcon, SnowflakeIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { SendResult } from "durable-machines/protocol";
import { formatValue, Notice, useView, type NoticeValue } from "@durable-machines/inspector";

type AccountContext = {
  balance: number;
  holds: Record<string, number>;
  notice: string | null;
  ledger: Array<{ id: string; kind: string; amount: number; counterparty: string | null; status: string }>;
};

const AMOUNTS = [10, 25, 150];
const RANDOM = "__random";

const command = async (body: Record<string, unknown>): Promise<SendResult> => {
  const response = await fetch("/bank/api/me", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
};

/** Your account: its balance, and the commands only you can send it. */
export function You({ accountId }: { accountId: string }) {
  const { view } = useView("BankAccount", accountId);
  const bank = useView("Bank", "global").view;
  const [to, setTo] = useState(RANDOM);
  const [amount, setAmount] = useState(AMOUNTS[0]!);
  const [notice, setNotice] = useState<NoticeValue>();
  const [busy, setBusy] = useState(false);

  const context = view?.root.context as AccountContext | undefined;
  const frozen = view?.root.value === "frozen";
  const others = ((bank?.root.context as { accounts?: string[] } | undefined)?.accounts ?? []).filter((a) => a !== accountId);
  const held = Object.values(context?.holds ?? {}).reduce((a, b) => a + b, 0);

  const run = async (body: Record<string, unknown>, label: string) => {
    setBusy(true);
    try {
      const result = await command(body);
      setNotice(result.ok ? { ok: true, text: `${label} → ${formatValue(result.value)}` } : { ok: false, text: result.error });
    } catch (error) {
      setNotice({ ok: false, text: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const target = to === RANDOM ? others[Math.floor(Math.random() * others.length)] : to;
    if (!target) return setNotice({ ok: false, text: "Nobody else is here yet" });
    void run({ action: "send", amount, to: target }, `Send $${amount} to ${target}`);
  };

  return (
    <footer className="grid gap-2.5 border-t border-kumo-line bg-kumo-elevated p-3">
      <div className="flex items-center gap-2">
        <div className="grid min-w-0 leading-tight">
          <Text size="xs" variant="secondary">
            This is you: <code className="font-mono">Account/{accountId}</code>
          </Text>
          <span className="text-2xl font-semibold tabular-nums text-kumo-strong">${context?.balance ?? "…"}</span>
        </div>
        <span className="ml-auto flex items-center gap-1.5">
          {held > 0 && <Badge variant="purple">${held} set aside</Badge>}
          <Badge variant={frozen ? "blue" : "orange"}>{formatValue(view?.root.value) || "…"}</Badge>
        </span>
      </div>
      {context?.notice && <Notice value={{ ok: false, text: context.notice }} />}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" icon={ArrowDownIcon} disabled={busy} onClick={() => void run({ action: "deposit", amount: 25 }, "Deposit $25")}>
          Deposit $25
        </Button>
        <Button size="sm" variant="secondary" icon={ArrowUpIcon} disabled={busy} onClick={() => void run({ action: "withdraw", amount: 10 }, "Withdraw $10")}>
          Withdraw $10
        </Button>
        <Button
          size="sm"
          variant={frozen ? "primary" : "secondary"}
          icon={SnowflakeIcon}
          disabled={busy}
          onClick={() => void run({ action: frozen ? "unfreeze" : "freeze" }, frozen ? "Unfreeze" : "Freeze")}
        >
          {frozen ? "Unfreeze" : "Freeze"}
        </Button>
      </div>
      <div className="flex items-end gap-1.5">
        <Select label="Send" value={String(amount)} onValueChange={(v) => setAmount(Number(v))} renderValue={(v) => `$${v}`} className="w-24">
          {AMOUNTS.map((a) => (
            <Select.Option key={a} value={String(a)}>
              ${a}
              {a >= 100 ? " (review)" : ""}
            </Select.Option>
          ))}
        </Select>
        <Select label="To" value={to} onValueChange={(v) => setTo(String(v))} renderValue={(v) => (v === RANDOM ? "A random stranger" : String(v))} className="min-w-0 flex-1">
          <Select.Option value={RANDOM}>A random stranger</Select.Option>
          {others.map((a) => (
            <Select.Option key={a} value={a}>
              {a === "bob" ? "bob (frozen: bounces)" : a}
            </Select.Option>
          ))}
        </Select>
        <Button size="sm" variant="primary" icon={PaperPlaneTiltIcon} disabled={busy} onClick={send}>
          Send
        </Button>
      </div>
      <Notice value={notice} />
    </footer>
  );
}
