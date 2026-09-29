import { memo } from "react";
import { GithubPanel } from "../views/connections/GithubPanel";
import type { PanelBodyProps } from "../workspace/registry";

export const GithubPanelBody = memo(function GithubPanelBody(_: PanelBodyProps) {
  return <GithubPanel bare />;
});
