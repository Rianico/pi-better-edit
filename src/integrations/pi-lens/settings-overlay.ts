/**
 * Interactive settings overlay — the headed form of `/pi-better-edit settings`.
 *
 * WHY this module keeps no I/O of its own: every diagnostic line derives from the
 * existing resolvers, readers and env consts, so the overlay cannot drift from the
 * status text it mirrors. Writes go through the matching saver for the active scope.
 */
import {
  Container,
  SettingsList,
  Text,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";

import {
  BASH_VIEW_ENV_VAR,
  readBashViewConfig,
  resolveBashViewModeWithSource,
  saveBashViewConfig,
  type BashViewMode,
} from "../../bash-view-config.js";
import { resolveBashMultiFileSettingsWithSources } from "../../bash-multifile-config.js";
import type { ConfigScope } from "../../json-config.js";
import {
  readLensBridgeConfig,
  resolveEffectiveLensModeWithSource,
  saveLensBridgeConfig,
  LENS_BRIDGE_ENV_VAR,
  type LensBridgeMode,
} from "./config.js";
import { saveStoreJanitorConfig } from "../../store-config.js";
import {
  readStoreJanitorConfig,
  resolveStoreJanitorSettingsWithSources,
  STORE_JANITOR_ENV_VAR,
} from "../../store-kernel/settings.js";

/** WHY a local theme: pi-tui 0.85.1 ships the interface but no factory, so identity styling keeps the rows legible without inventing border art. */
function getSettingsListTheme(): SettingsListTheme {
  return {
    label: (text: string): string => text,
    value: (text: string): string => text,
    description: (text: string): string => text,
    cursor: "> ",
    hint: (text: string): string => text,
  };
}

function envDisplay(raw: string | undefined): string {
  if (raw === undefined) return "unset";
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : "unset";
}

function lensLine2(cwd: string): string {
  const effective = resolveEffectiveLensModeWithSource(cwd);
  const config = readLensBridgeConfig(cwd);
  const line =
    `Effective: ${effective.mode} (source: ${effective.source}) ` +
    `\u2022 Global: ${config.global ?? "unset"} \u2022 Env: ${envDisplay(process.env[LENS_BRIDGE_ENV_VAR])}`;
  return effective.source === "env"
    ? `\u26a0\ufe0f Overridden by ${LENS_BRIDGE_ENV_VAR} \u2022 ${line}`
    : line;
}

function bashViewLine2(cwd: string): string {
  const effective = resolveBashViewModeWithSource(cwd);
  const config = readBashViewConfig(cwd);
  const line =
    `Effective: ${effective.value} (source: ${effective.source}) ` +
    `\u2022 Global: ${config.global ?? "unset"} \u2022 Env: ${envDisplay(process.env[BASH_VIEW_ENV_VAR])}`;
  return effective.source === "env"
    ? `\u26a0\ufe0f Overridden by ${BASH_VIEW_ENV_VAR} \u2022 ${line}`
    : line;
}

/**
 * The multi-file caps, REPORTED ONLY (ADR-0049 M6): the overlay's `SettingsList` is enum-only
 * (ADR-0038), so numeric editing belongs to `/pi-better-edit bash-view multi-file …`. This line still
 * names each cap's rung, because a display that showed the effective numbers without their source
 * would hide which file to edit.
 */
function multiFileLine(cwd: string): string {
  const caps = resolveBashMultiFileSettingsWithSources(cwd);
  return (
    `Multi-file caps: maxFiles ${caps.maxFiles.value} (source: ${caps.maxFiles.source}) ` +
    `\u2022 maxRows ${caps.maxRows.value} (source: ${caps.maxRows.source})`
  );
}

function storeLine2(cwd: string): string {
  const effective = resolveStoreJanitorSettingsWithSources(cwd);
  const config = readStoreJanitorConfig(cwd);
  const line =
    `Effective: ${effective.mode.value} (source: ${effective.mode.source}) ` +
    `\u2022 Global: ${config.global?.mode ?? "unset"} \u2022 Env: ${envDisplay(process.env[STORE_JANITOR_ENV_VAR])}`;
  return effective.mode.source === "env"
    ? `\u26a0\ufe0f Overridden by ${STORE_JANITOR_ENV_VAR} \u2022 ${line}`
    : line;
}

function targetScopeLine2(scope: ConfigScope): string {
  return `Effective: ${scope} (source: switch) \u2022 Global: n/a \u2022 Env: n/a`;
}

/**
 * The overlay: a title plus the four-row settings list. The list keeps the item
 * array by reference, so refreshes mutate descriptions in place and invalidate.
 */
export class SettingsOverlay extends Container {
  private readonly cwd: string;
  private readonly done: (result: undefined) => void;
  private scope: ConfigScope = "project";
  private readonly items: SettingItem[];
  private readonly list: SettingsList;

  constructor(cwd: string, done: (result: undefined) => void) {
    super();
    this.cwd = cwd;
    this.done = done;
    this.items = [
      {
        id: "target-scope",
        label: "Target scope",
        description: `Write scope for the rows below\n${targetScopeLine2(this.scope)}`,
        currentValue: this.scope,
        values: ["project", "global"],
      },
      {
        id: "lens",
        label: "Lens bridge",
        description: `Bridge to pi-lens diagnostics\n${lensLine2(this.cwd)}`,
        currentValue: resolveEffectiveLensModeWithSource(this.cwd).mode,
        values: ["auto", "on", "off"],
      },
      {
        id: "bash-view",
        label: "Bash view",
        description: `Bash view interception switch\n${bashViewLine2(this.cwd)}\n${multiFileLine(this.cwd)}`,
        currentValue: resolveBashViewModeWithSource(this.cwd).value,
        values: ["on", "off"],
      },
      {
        id: "store",
        label: "Store janitor",
        description: `Store janitor sweep switch\n${storeLine2(this.cwd)}`,
        currentValue: resolveStoreJanitorSettingsWithSources(this.cwd).mode.value,
        values: ["on", "off"],
      },
    ];
    this.list = new SettingsList(
      this.items,
      8,
      getSettingsListTheme(),
      (id, newValue) => {
        this.handleChange(id, newValue);
      },
      () => {
        this.done(undefined);
      },
    );
    this.addChild(new Text("pi-better-edit settings", 1, 0));
    this.addChild(this.list);
  }

  /** WHY a delegating input: Container owns layout only, so focus keys reach the list. */
  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  /** Test and routing seam to surface a row's two-line description. */
  selectItem(id: string): void {
    this.list.selectItem(id);
  }

  /** Active write scope; the Target Scope row cycles it without persisting. */
  currentScope(): ConfigScope {
    return this.scope;
  }

  private handleChange(id: string, newValue: string): void {
    if (id === "target-scope") {
      this.scope = newValue === "global" ? "global" : "project";
      this.refreshAll();
      return;
    }
    if (id === "lens" && (newValue === "auto" || newValue === "on" || newValue === "off")) {
      const mode: LensBridgeMode = newValue;
      saveLensBridgeConfig(mode, this.scope, this.cwd);
      this.refreshRow("lens");
      return;
    }
    if (id === "bash-view" && (newValue === "on" || newValue === "off")) {
      const mode: BashViewMode = newValue;
      saveBashViewConfig(mode, this.scope, this.cwd);
      this.refreshRow("bash-view");
      return;
    }
    if (id === "store" && (newValue === "on" || newValue === "off")) {
      saveStoreJanitorConfig({ mode: newValue }, this.scope, this.cwd);
      this.refreshRow("store");
    }
  }

  private refreshRow(id: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item === undefined) return;
    if (id === "lens") {
      const effective = resolveEffectiveLensModeWithSource(this.cwd);
      this.list.updateValue(id, effective.mode);
      item.description = `Bridge to pi-lens diagnostics\n${lensLine2(this.cwd)}`;
    } else if (id === "bash-view") {
      const effective = resolveBashViewModeWithSource(this.cwd);
      this.list.updateValue(id, effective.value);
      item.description = `Bash view interception switch\n${bashViewLine2(this.cwd)}\n${multiFileLine(this.cwd)}`;
    } else if (id === "store") {
      const effective = resolveStoreJanitorSettingsWithSources(this.cwd);
      this.list.updateValue(id, effective.mode.value);
      item.description = `Store janitor sweep switch\n${storeLine2(this.cwd)}`;
    }
    this.list.invalidate();
    this.invalidate();
  }

  private refreshAll(): void {
    const scopeItem = this.items.find((candidate) => candidate.id === "target-scope");
    if (scopeItem !== undefined) {
      this.list.updateValue("target-scope", this.scope);
      scopeItem.description = `Write scope for the rows below\n${targetScopeLine2(this.scope)}`;
    }
    this.refreshRow("lens");
    this.refreshRow("bash-view");
    this.refreshRow("store");
  }
}
