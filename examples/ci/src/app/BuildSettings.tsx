import { Button, Checkbox, Input, Text } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { ProjectSettings } from "./types";

/** Workers Builds settings. Saved with `settings.update`; the machine's schema validates them. */
export function BuildSettingsForm({
  settings,
  productionBranch,
  onSave,
}: {
  settings: ProjectSettings;
  productionBranch: string;
  onSave: (s: ProjectSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const text = (key: Exclude<keyof ProjectSettings, "previewBuilds">, label: string, description?: string) => (
    <Input label={label} description={description} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className="font-mono" />
  );
  return (
    <div className="grid gap-3">
      {text("rootDirectory", "Root directory")}
      {text("buildCommand", "Build command", "Optional. Leave empty to skip the build step.")}
      {text("deployCommand", "Deploy command", `Runs for ${productionBranch}.`)}
      {text("previewDeployCommand", "Non-production deploy command", "Runs for preview branches.")}
      <Checkbox
        label="Build non-production branches (with an open PR)"
        checked={draft.previewBuilds}
        onCheckedChange={(on) => setDraft({ ...draft, previewBuilds: Boolean(on) })}
      />
      <Text size="xs" variant="secondary">
        Applies to builds requested after saving. Clear a deploy command to see the schema reject it.
      </Text>
      <Button variant="primary" disabled={!dirty} onClick={() => onSave(draft)} className="justify-self-end">
        Save
      </Button>
    </div>
  );
}
