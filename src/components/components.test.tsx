import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";
import { PermissionEditor } from "./PermissionEditor";
import { CAPABILITIES } from "../lib/labels";
import type { PermissionSet } from "../lib/types";

afterEach(cleanup);

function permissionSet(access: PermissionSet[keyof PermissionSet]): PermissionSet {
  return Object.fromEntries(CAPABILITIES.map((c) => [c.key, access])) as PermissionSet;
}

describe("StatusBadge", () => {
  it("renders the exact agent status with its label", () => {
    const { container } = render(<StatusBadge status="awaiting_permission" />);
    const badge = container.querySelector(".status-badge")!;
    expect(badge.getAttribute("data-status")).toBe("awaiting_permission");
    expect(badge.className).toContain("tone-amber");
    expect(screen.getByText("Awaiting permission")).toBeTruthy();
  });
});

describe("PermissionEditor", () => {
  it("shows one control per capability and reports changes", () => {
    const onChange = vi.fn();
    const value = permissionSet("ask");
    const { container } = render(<PermissionEditor value={value} onChange={onChange} />);
    expect(container.querySelectorAll(".perm-row")).toHaveLength(CAPABILITIES.length);

    const row = container.querySelector('[data-capability="git_write"]')!;
    const allow = [...row.querySelectorAll("button")].find((b) => b.textContent === "Allow")!;
    fireEvent.click(allow);
    expect(onChange).toHaveBeenCalledWith({ ...value, git_write: "allow" });
  });

  it("flags capabilities above the ceiling", () => {
    const { container } = render(<PermissionEditor value={permissionSet("allow")} onChange={() => undefined} ceiling={permissionSet("ask")} />);
    expect(container.querySelectorAll(".perm-over")).toHaveLength(CAPABILITIES.length);
  });
});
