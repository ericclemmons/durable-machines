import { Button, Sidebar, Text } from "@cloudflare/kumo";
import { ShikiProvider } from "@cloudflare/kumo/code";
import { BankIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { EventPanel, useAllViews, useMachine } from "@durable-machines/inspector";
import { BankMap } from "./BankMap";
import { You } from "./You";

/** How many of your latest transfers, and their counterparties, the canvas follows. */
const FOLLOW = 2;

function Connection({ address }: { address: string }) {
  const [kind = "", ...rest] = address.split("/");
  useMachine(kind, rest.join("/"));
  return null;
}

/**
 * Which objects to watch. It starts from your account and the Bank, then
 * follows the wires: the Transfers your account talked to, and the accounts
 * on the other end of them.
 */
function useFollowed(me: string) {
  const views = new Map(useAllViews());
  const transfers: string[] = [];
  for (const o of [...(views.get(me)?.outbox ?? [])].reverse()) if (o.to.startsWith("Transfer/") && !transfers.includes(o.to)) transfers.push(o.to);
  for (const e of [...(views.get(me)?.journal ?? [])].reverse()) {
    const peer = e.kind === "sent" ? e.target : e.kind === "transition" ? e.source : undefined;
    if (peer?.startsWith("Transfer/") && !transfers.includes(peer)) transfers.push(peer);
    if (transfers.length === FOLLOW) break;
  }
  const accounts = new Set<string>();
  for (const t of transfers) {
    const context = views.get(t)?.root.context as { from?: string; to?: string } | undefined;
    for (const id of [context?.from, context?.to]) if (id && `Account/${id}` !== me) accounts.add(`Account/${id}`);
  }
  return [me, ...transfers.reverse(), ...accounts, "Bank/global"];
}

export function App() {
  const [accountId, setAccountId] = useState<string>();
  const [open, setOpen] = useState(() => localStorage.getItem("panel:events") !== "closed");
  useEffect(() => localStorage.setItem("panel:events", open ? "open" : "closed"), [open]);
  useEffect(() => {
    fetch("/api/me").then(async (r) => setAccountId(((await r.json()) as { accountId: string }).accountId));
  }, []);
  if (!accountId) return <div className="p-8 text-kumo-subtle">Opening your account…</div>;
  return <Bank me={`Account/${accountId}`} accountId={accountId} open={open} setOpen={setOpen} />;
}

function Bank({ me, accountId, open, setOpen }: { me: string; accountId: string; open: boolean; setOpen: (open: boolean) => void }) {
  const keys = useFollowed(me);
  return (
    <ShikiProvider engine="javascript" languages={["json"]}>
      {keys.map((k) => (
        <Connection key={k} address={k} />
      ))}
      <Sidebar.Provider
        side="left"
        collapsible="offcanvas"
        resizable
        defaultWidth={420}
        minWidth={340}
        maxWidth={800}
        open={open}
        onOpenChange={setOpen}
        className="isolate h-screen bg-kumo-canvas"
      >
        <Sidebar aria-label="Events">
          <EventPanel
            emptyText="No events yet. Deposit or send some money to see what happens."
            header={
              <header className="flex items-center gap-2.5 border-b border-kumo-line px-3 py-2">
                <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-kumo-brand text-white">
                  <BankIcon weight="bold" />
                </div>
                <div className="grid min-w-0 leading-tight">
                  <Text as="h1" variant="heading3">
                    Durable Bank
                  </Text>
                  <Text size="xs" variant="secondary">
                    <a className="underline" href="https://github.com/ericclemmons/durable-machines">durable-machines</a> · XState v6 on Durable Objects
                  </Text>
                </div>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  icon={SidebarSimpleIcon}
                  aria-label="Hide events"
                  onClick={() => setOpen(false)}
                  className="ml-auto"
                />
              </header>
            }
            footer={<You me={me} accountId={accountId} />}
          />
          <Sidebar.ResizeHandle />
        </Sidebar>
        <main className="relative flex h-screen min-w-0 flex-1 flex-col">
          {!open && (
            <Button
              variant="secondary"
              shape="square"
              size="sm"
              icon={SidebarSimpleIcon}
              aria-label="Show events"
              onClick={() => setOpen(true)}
              className="absolute left-3 top-3 z-20"
            />
          )}
          <BankMap keys={keys} me={me} />
        </main>
      </Sidebar.Provider>
    </ShikiProvider>
  );
}
