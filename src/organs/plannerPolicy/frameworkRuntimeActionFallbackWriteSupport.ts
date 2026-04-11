/**
 * @fileoverview Framework fallback write-target resolution kept separate to preserve thin planner
 * policy modules.
 */

import { existsSync } from "node:fs";

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import {
  buildFrameworkLandingPageContent,
  buildFrameworkLandingPageStyles,
  buildNextLayoutContent,
  buildNextTypeScriptLayoutContent
} from "./frameworkRuntimeActionFallbackContent";
import { getPathModuleForPathValue } from "./frameworkPathSupport";

export interface FrameworkLandingPageTargetPaths {
  readonly primaryViewPath: string;
  readonly primaryViewAliasPath: string | null;
  readonly layoutPath: string | null;
  readonly layoutAliasPath: string | null;
  readonly stylesheetPath: string;
  readonly useTypeScriptView: boolean;
  readonly useTypeScriptLayout: boolean;
}

/**
 * Resolves deterministic framework landing-page target files using the active workspace state.
 *
 * @param kind - Framework scaffold kind resolved from the request.
 * @param finalFolderPath - Exact requested project folder path.
 * @returns Preferred and shadow-prone target paths for deterministic landing-page writes.
 */
export function resolveFrameworkLandingPageTargetPaths(
  kind: "vite_react" | "next_js",
  finalFolderPath: string
): FrameworkLandingPageTargetPaths {
  const pathModule = getPathModuleForPathValue(finalFolderPath);
  if (kind === "next_js") {
    const appDirectoryPath = pathModule.join(finalFolderPath, "app");
    const nextPageTsxPath = pathModule.join(appDirectoryPath, "page.tsx");
    const nextPageJsPath = pathModule.join(appDirectoryPath, "page.js");
    const nextLayoutTsxPath = pathModule.join(appDirectoryPath, "layout.tsx");
    const nextLayoutJsPath = pathModule.join(appDirectoryPath, "layout.js");
    const useTypeScriptView =
      existsSync(nextPageTsxPath) ||
      (!existsSync(nextPageJsPath) &&
        (existsSync(pathModule.join(finalFolderPath, "tsconfig.json")) ||
          existsSync(pathModule.join(finalFolderPath, "next-env.d.ts"))));
    const useTypeScriptLayout =
      existsSync(nextLayoutTsxPath) ||
      (!existsSync(nextLayoutJsPath) &&
        (existsSync(pathModule.join(finalFolderPath, "tsconfig.json")) ||
          existsSync(pathModule.join(finalFolderPath, "next-env.d.ts"))));
    return {
      primaryViewPath: useTypeScriptView ? nextPageTsxPath : nextPageJsPath,
      primaryViewAliasPath:
        useTypeScriptView && existsSync(nextPageJsPath)
          ? nextPageJsPath
          : !useTypeScriptView && existsSync(nextPageTsxPath)
            ? nextPageTsxPath
            : null,
      layoutPath: useTypeScriptLayout ? nextLayoutTsxPath : nextLayoutJsPath,
      layoutAliasPath:
        useTypeScriptLayout && existsSync(nextLayoutJsPath)
          ? nextLayoutJsPath
          : !useTypeScriptLayout && existsSync(nextLayoutTsxPath)
            ? nextLayoutTsxPath
            : null,
      stylesheetPath: pathModule.join(appDirectoryPath, "globals.css"),
      useTypeScriptView,
      useTypeScriptLayout
    };
  }

  const sourceDirectoryPath = pathModule.join(finalFolderPath, "src");
  const reactViewTsxPath = pathModule.join(sourceDirectoryPath, "App.tsx");
  const reactViewJsxPath = pathModule.join(sourceDirectoryPath, "App.jsx");
  const useTypeScriptView =
    existsSync(reactViewTsxPath) ||
    (!existsSync(reactViewJsxPath) &&
      (existsSync(pathModule.join(finalFolderPath, "tsconfig.json")) ||
        existsSync(pathModule.join(sourceDirectoryPath, "main.tsx")) ||
        existsSync(pathModule.join(finalFolderPath, "vite-env.d.ts"))));
  return {
    primaryViewPath: useTypeScriptView ? reactViewTsxPath : reactViewJsxPath,
    primaryViewAliasPath:
      useTypeScriptView && existsSync(reactViewJsxPath)
        ? reactViewJsxPath
        : !useTypeScriptView && existsSync(reactViewTsxPath)
          ? reactViewTsxPath
          : null,
    layoutPath: null,
    layoutAliasPath: null,
    stylesheetPath: pathModule.join(sourceDirectoryPath, "index.css"),
    useTypeScriptView,
    useTypeScriptLayout: false
  };
}

/**
 * Builds deterministic write-file actions for framework landing-page source files.
 *
 * @param kind - Framework scaffold kind resolved from the request.
 * @param finalFolderPath - Exact project folder path.
 * @param appTitle - Human-facing app title from the request.
 * @returns Ordered write-file actions.
 */
export function buildFrameworkLandingPageWriteActions(
  kind: "vite_react" | "next_js",
  finalFolderPath: string,
  appTitle: string,
  currentUserRequest: string
): PlannedAction[] {
  const targetPaths = resolveFrameworkLandingPageTargetPaths(kind, finalFolderPath);
  const viewContent = buildFrameworkLandingPageContent(kind, appTitle, currentUserRequest);
  const layoutContent =
    kind === "next_js"
      ? targetPaths.useTypeScriptLayout
        ? buildNextTypeScriptLayoutContent(appTitle)
        : buildNextLayoutContent(appTitle)
      : null;
  const styleContent = buildFrameworkLandingPageStyles(currentUserRequest, appTitle);
  const actions: PlannedAction[] = [];
  if (kind === "next_js") {
    const pathModule = getPathModuleForPathValue(finalFolderPath);
    const nextLayoutPath =
      targetPaths.layoutPath ?? pathModule.join(finalFolderPath, "app", "layout.js");
    const nextLayoutContent = layoutContent ?? buildNextLayoutContent(appTitle);
    actions.push({
      id: makeId("action"),
      type: "write_file",
      description: "Write the Next.js app layout metadata for the landing page.",
      params: { path: nextLayoutPath, content: nextLayoutContent },
      estimatedCostUsd: estimateActionCostUsd({
        type: "write_file",
        params: { path: nextLayoutPath, content: nextLayoutContent }
      })
    });
    if (targetPaths.layoutAliasPath) {
      const aliasLayoutContent = targetPaths.layoutAliasPath.endsWith(".tsx")
        ? buildNextTypeScriptLayoutContent(appTitle)
        : buildNextLayoutContent(appTitle);
      actions.push({
        id: makeId("action"),
        type: "write_file",
        description:
          "Keep the alternate Next.js layout route file aligned so stale extension variants cannot shadow the landing page.",
        params: { path: targetPaths.layoutAliasPath, content: aliasLayoutContent },
        estimatedCostUsd: estimateActionCostUsd({
          type: "write_file",
          params: { path: targetPaths.layoutAliasPath, content: aliasLayoutContent }
        })
      });
    }
    actions.push({
      id: makeId("action"),
      type: "write_file",
      description:
        "Write the Next.js landing page content using the deterministic request-matched visual theme and section count.",
      params: { path: targetPaths.primaryViewPath, content: viewContent },
      estimatedCostUsd: estimateActionCostUsd({
        type: "write_file",
        params: { path: targetPaths.primaryViewPath, content: viewContent }
      })
    });
    if (targetPaths.primaryViewAliasPath) {
      actions.push({
        id: makeId("action"),
        type: "write_file",
        description:
          "Keep the alternate Next.js page route file aligned so stale extension variants cannot shadow the landing page.",
        params: { path: targetPaths.primaryViewAliasPath, content: viewContent },
        estimatedCostUsd: estimateActionCostUsd({
          type: "write_file",
          params: { path: targetPaths.primaryViewAliasPath, content: viewContent }
        })
      });
    }
    actions.push({
      id: makeId("action"),
      type: "write_file",
      description:
        "Write the deterministic stylesheet for the Next.js landing page theme.",
      params: { path: targetPaths.stylesheetPath, content: styleContent },
      estimatedCostUsd: estimateActionCostUsd({
        type: "write_file",
        params: { path: targetPaths.stylesheetPath, content: styleContent }
      })
    });
    return actions;
  }

  actions.push({
    id: makeId("action"),
    type: "write_file",
    description:
      "Write the React landing page content using the deterministic request-matched visual theme and section count.",
    params: { path: targetPaths.primaryViewPath, content: viewContent },
    estimatedCostUsd: estimateActionCostUsd({
      type: "write_file",
      params: { path: targetPaths.primaryViewPath, content: viewContent }
    })
  });
  if (targetPaths.primaryViewAliasPath) {
    actions.push({
      id: makeId("action"),
      type: "write_file",
      description:
        "Keep the alternate React entry file aligned so stale extension variants cannot shadow the landing page.",
      params: { path: targetPaths.primaryViewAliasPath, content: viewContent },
      estimatedCostUsd: estimateActionCostUsd({
        type: "write_file",
        params: { path: targetPaths.primaryViewAliasPath, content: viewContent }
      })
    });
  }
  actions.push({
    id: makeId("action"),
    type: "write_file",
    description:
      "Write the deterministic stylesheet for the React landing page theme.",
    params: { path: targetPaths.stylesheetPath, content: styleContent },
    estimatedCostUsd: estimateActionCostUsd({
      type: "write_file",
      params: { path: targetPaths.stylesheetPath, content: styleContent }
    })
  });
  return actions;
}
