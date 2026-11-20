import { Badge, Text } from "@cloudflare/kumo";
import {
  Canvas,
  Dock,
  formatValue,
  ObjectLabel,
  objectPurpose,
  StateBody,
  stateAt,
  useAllViews,
  useDockOwner,
  useInspected,
  useObjectState,
  wiresFromJournals,
  type SystemPart,
} from "@durable-machines/inspector";

const WORKER = "Worker";

/** A part id for an object address. Node ids are `${part}/${state}`, so a part id has no "/". */
const partId = (address: string) => address.replace("/", "~");
const addressOf = (part: string) => part.replace("~", "/");

/**
 * Every object you're connected to, on one canvas, with an object's state
 * docked below it. Each object is a box with its machine's statechart, and the
 * wires are the messages the journals and outboxes show going between them.
 */
export function BankMap({ keys, me }: { keys: string[]; me: string }) {
  const all = new Map(useAllViews());
  const views = new Map(
    keys.flatMap((k) => {
      const v = all.get(k);
      return v ? [[k, v] as const] : [];
    }),
  );
  const partOf = (address: string) => (views.has(address) ? partId(address) : address === "external" ? WORKER : undefined);
  const wires = wiresFromJournals(views, partOf);
  const parts: SystemPart[] = [
    ...(wires.some((w) => w.source === WORKER) ? [{ id: WORKER, title: WORKER, subtitle: objectPurpose(WORKER) ?? "" }] : []),
    ...[...views].map(([key, v]) => ({
      id: partId(key),
      title: key,
      subtitle: `${key === me ? "You · " : ""}${objectPurpose(key) ?? ""}`,
      definition: v.definitions[v.machineId],
    })),
  ];

  const owner = useDockOwner(addressOf, me);
  const point = useInspected();
  const state = useObjectState(owner, point);

  return (
    <Canvas
      parts={parts}
      wires={wires}
      partOf={partOf}
      direction="RIGHT"
      statesAt={(at) =>
        [...views].map(([key, v]) => {
          const { root } = stateAt(key, v, at);
          return { part: partId(key), value: root.value, done: root.status === "done" };
        })
      }
      dock={
        <Dock
          sections={[
            {
              label: (
                <>
                  <Text size="sm" bold>
                    State
                  </Text>
                  <ObjectLabel address={owner} className="min-w-0 text-sm text-kumo-subtle" />
                </>
              ),
              actions: !state.missing && (
                <Badge variant="orange">
                  <span className="truncate font-mono text-[0.9em]">{formatValue(state.value)}</span>
                </Badge>
              ),
              body: <StateBody state={state} />,
            },
          ]}
        />
      }
    />
  );
}
