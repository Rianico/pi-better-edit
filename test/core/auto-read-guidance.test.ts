import { describe, expect, it } from "vitest";
import { buildToolDef as buildBulkToolDef, buildToolDefFlat } from "../../src/replace";

function checkDescription(toolDef: { description: string }, expectAutoMsg: boolean): void {
  const hasAutoMsg = toolDef.description.includes("Anchors are provided automatically after write and replace operations");
  const hasReadCall = toolDef.description.includes("Call `read` to get fresh anchors for follow-up edits.");
  if (expectAutoMsg) {
    expect(hasAutoMsg).toBe(true);
    expect(hasReadCall).toBe(false);
  } else {
    expect(hasAutoMsg).toBe(false);
    expect(hasReadCall).toBe(true);
  }
}

function checkGuidelines(guidelines: string[], expectAutoMsg: boolean): void {
  const hasAutoMsg = guidelines.some((g) =>
    g.includes("Anchors are provided automatically after write and replace operations")
  );
  const hasReadCall = guidelines.some((g) =>
    g.includes("Call `read` to get fresh anchors for follow-up edits.")
  );
  if (expectAutoMsg) {
    expect(hasAutoMsg).toBe(true);
    expect(hasReadCall).toBe(false);
  } else {
    expect(hasAutoMsg).toBe(false);
    expect(hasReadCall).toBe(true);
  }
}

describe("auto-read guidance in bulk mode tool definition", () => {
  it("shows auto-read message in description and guidelines when autoRead is true", () => {
    const toolDef = buildBulkToolDef({ flat: false, autoRead: true });
    checkDescription(toolDef, true);
    checkGuidelines(toolDef.promptGuidelines ?? [], true);
  });

  it("shows 'Call `read`' message in description and guidelines when autoRead is false", () => {
    const toolDef = buildBulkToolDef({ flat: false, autoRead: false });
    checkDescription(toolDef, false);
    checkGuidelines(toolDef.promptGuidelines ?? [], false);
  });

  it("defaults to 'Call `read`' when autoRead is not provided", () => {
    const toolDef = buildBulkToolDef({ flat: false });
    checkDescription(toolDef, false);
    checkGuidelines(toolDef.promptGuidelines ?? [], false);
  });
});

describe("auto-read guidance in flat mode tool definition", () => {
  it("shows auto-read message in description and guidelines when autoRead is true", () => {
    const toolDef = buildToolDefFlat(true);
    checkDescription(toolDef, true);
    checkGuidelines(toolDef.promptGuidelines ?? [], true);
  });

  it("shows 'Call `read`' message in description and guidelines when autoRead is false", () => {
    const toolDef = buildToolDefFlat(false);
    checkDescription(toolDef, false);
    checkGuidelines(toolDef.promptGuidelines ?? [], false);
  });

  it("defaults to 'Call `read`' when autoRead is not provided", () => {
    const toolDef = buildToolDefFlat();
    checkDescription(toolDef, false);
    checkGuidelines(toolDef.promptGuidelines ?? [], false);
  });
});
