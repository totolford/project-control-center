import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import type { CapabilityMatrix } from "../../lib/platform";
import { CapabilityMatrixSection } from "./PlatformSections";

const cell = (support: "supported" | "partial" | "unavailable", note: string | null = null) => ({ support, note });

const matrix: CapabilityMatrix = {
  environment: "ubuntu",
  rows: [
    {
      id: "roblox",
      name: "Roblox Studio + MCP",
      windows: cell("supported"),
      ubuntu: cell("unavailable", "Roblox Studio has no Linux version"),
      wsl: cell("unavailable", "Windows only"),
      docker: cell("unavailable", "Windows only"),
      live: { state: "notApplicable", detail: "Windows only" },
    },
    {
      id: "future-row",
      name: "Something new",
      windows: cell("partial"),
      ubuntu: cell("supported"),
      wsl: cell("supported"),
      docker: cell("supported"),
      live: { state: "available", detail: "/usr/bin/x" },
    },
  ],
};

afterEach(() => {
  cleanup();
  act(() => i18n.setLocale("en"));
});

describe("Platform Capability Matrix", () => {
  it("shows support per platform, the live status and marks this machine's column", () => {
    render(<CapabilityMatrixSection matrix={matrix} loading={false} error={null} />);
    expect(screen.getByText("Roblox Studio + MCP")).toBeTruthy();
    expect(screen.getByText("Roblox Studio has no Linux version")).toBeTruthy();
    expect(screen.getByText("Not on this OS")).toBeTruthy();
    expect(screen.getByText("this machine").closest("th")?.textContent).toContain("Ubuntu");
  });

  it("translates labels and row names, keeping the backend name for unknown rows", () => {
    act(() => i18n.setLocale("fr"));
    render(<CapabilityMatrixSection matrix={matrix} loading={false} error={null} />);
    expect(screen.getByText("Capacités de la plateforme")).toBeTruthy();
    expect(screen.getAllByText("Indisponible").length).toBeGreaterThan(0);
    expect(screen.getByText("Something new")).toBeTruthy();
    expect(screen.getByText("Pas sur cet OS")).toBeTruthy();
  });

  it("says why when the matrix cannot be read", () => {
    render(<CapabilityMatrixSection matrix={null} loading={false} error="backend down" />);
    expect(screen.getByText("Unavailable: backend down")).toBeTruthy();
  });
});
