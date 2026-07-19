import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FileEntry } from "../domain/models";
import {
  buildWorkspaceTree,
  createWorkspaceTreeState,
  transitionWorkspaceTree,
  visibleWorkspaceNodes,
  WorkspaceFileTree,
  type WorkspaceTreeState,
} from "./WorkspaceFileTree";

const entries: FileEntry[] = [
  { name: "src", relativePath: "src", isDirectory: true, depth: 0 },
  { name: "components", relativePath: "src/components", isDirectory: true, depth: 1 },
  { name: "Tree.tsx", relativePath: "src/components/Tree.tsx", isDirectory: false, depth: 2 },
  { name: "main.tsx", relativePath: "src/main.tsx", isDirectory: false, depth: 1 },
  { name: "empty", relativePath: "empty", isDirectory: true, depth: 0 },
  { name: "README.md", relativePath: "README.md", isDirectory: false, depth: 0 },
];

describe("WorkspaceFileTree", () => {
  it("renders only top-level nodes collapsed with tree ARIA and one roving tab stop", () => {
    const markup = renderToStaticMarkup(<WorkspaceFileTree entries={entries} />);

    expect(markup).toContain('role="tree"');
    expect(markup.match(/role="treeitem"/g)).toHaveLength(3);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(1);
    expect(markup).not.toContain('title="components"');
    expect(markup).not.toContain('title="main.tsx"');
    expect(markup).toMatch(/aria-level="1" aria-posinset="3" aria-setsize="3"[^>]*title="README.md"/);
    expect(markup).toMatch(/<div[^>]*title="empty"/);
  });

  it("uses folder icons for every directory and FileCode icons for files", () => {
    const markup = renderToStaticMarkup(<WorkspaceFileTree entries={entries} />);

    expect(markup.match(/data-icon="folder"/g)).toHaveLength(2);
    expect(markup.match(/data-icon="file"/g)).toHaveLength(1);
    expect(markup).not.toContain('data-icon="folderOpen"');
  });

  it("navigates Down, Up, Home, and End over visible nodes", () => {
    const nodes = buildWorkspaceTree(entries);
    let state: WorkspaceTreeState = {
      expanded: new Set(nodes.filter((node) => node.hasChildren).map((node) => node.id)),
      activeId: nodes[0].id,
    };
    state = transitionWorkspaceTree(nodes, state, nodes[0].id, "ArrowDown");
    expect(state.activeId).toBe(nodes[1].id);
    state = transitionWorkspaceTree(nodes, state, nodes[1].id, "ArrowUp");
    expect(state.activeId).toBe(nodes[0].id);
    expect(transitionWorkspaceTree(nodes, state, nodes[0].id, "End").activeId).toBe(nodes[5].id);
    expect(transitionWorkspaceTree(nodes, state, nodes[0].id, "Home").activeId).toBe(nodes[0].id);
  });

  it("uses Right to expand or visit the first child and Left to collapse or visit the parent", () => {
    const nodes = buildWorkspaceTree(entries);
    let state: WorkspaceTreeState = { expanded: new Set(), activeId: nodes[0].id };
    state = transitionWorkspaceTree(nodes, state, nodes[0].id, "ArrowRight");
    expect(state.expanded.has(nodes[0].id)).toBe(true);
    state = transitionWorkspaceTree(nodes, state, nodes[0].id, "ArrowRight");
    expect(state.activeId).toBe(nodes[1].id);
    state = transitionWorkspaceTree(nodes, state, nodes[1].id, "ArrowLeft");
    expect(state.expanded.has(nodes[1].id)).toBe(false);
    state = transitionWorkspaceTree(nodes, state, nodes[1].id, "ArrowLeft");
    expect(state.activeId).toBe(nodes[0].id);
  });

  it("toggles expandable parents with Enter and Space but leaves end nodes unchanged", () => {
    const nodes = buildWorkspaceTree(entries);
    const initial: WorkspaceTreeState = { expanded: new Set(), activeId: null };
    const entered = transitionWorkspaceTree(nodes, initial, nodes[0].id, "Enter");
    expect(entered.expanded.has(nodes[0].id)).toBe(true);
    expect(transitionWorkspaceTree(nodes, entered, nodes[0].id, " ").expanded.has(nodes[0].id)).toBe(false);

    const emptyDirectory = nodes[4];
    const endState = transitionWorkspaceTree(nodes, initial, emptyDirectory.id, "Enter");
    expect(endState.expanded).toEqual(new Set());
    expect(transitionWorkspaceTree(nodes, endState, emptyDirectory.id, "ArrowRight").activeId).toBe(emptyDirectory.id);
    expect(transitionWorkspaceTree(nodes, endState, emptyDirectory.id, "ArrowLeft").activeId).toBe(emptyDirectory.id);
  });

  it("collapses duplicate lossy paths independently by unique node ID", () => {
    const duplicateEntries: FileEntry[] = [
      { name: "first", relativePath: "duplicate", isDirectory: true, depth: 0 },
      { name: "first-child", relativePath: "duplicate/child", isDirectory: false, depth: 1 },
      { name: "second", relativePath: "duplicate", isDirectory: true, depth: 0 },
      { name: "second-child", relativePath: "duplicate/child", isDirectory: false, depth: 1 },
    ];
    const nodes = buildWorkspaceTree(duplicateEntries);
    const visible = visibleWorkspaceNodes(nodes, new Set([nodes[2].id]));

    expect(visible.map(({ entry }) => entry.name)).toEqual(["first", "second", "second-child"]);
  });

  it("derives expandability, parents, levels, and sibling sets from represented relationships", () => {
    const nodes = buildWorkspaceTree(entries);

    expect(nodes[0]).toMatchObject({ hasChildren: true, parentId: null, level: 1, position: 1, setSize: 3 });
    expect(nodes[1]).toMatchObject({ hasChildren: true, parentId: nodes[0].id, level: 2, position: 1, setSize: 2 });
    expect(nodes[2]).toMatchObject({ hasChildren: false, parentId: nodes[1].id, level: 3, position: 1, setSize: 1 });
    expect(nodes[4]).toMatchObject({ hasChildren: false, parentId: null, position: 2, setSize: 3 });
  });

  it("creates independent empty expanded sets so every directory defaults folded", () => {
    const nodes = buildWorkspaceTree(entries);
    const first = createWorkspaceTreeState();
    first.expanded.add(nodes[0].id);
    const replacement = createWorkspaceTreeState();

    expect(first.expanded.size).toBe(1);
    expect(replacement).toEqual({ expanded: new Set(), activeId: null });
    expect(replacement.expanded).not.toBe(first.expanded);
  });

  it("keeps stable unique ids when unrelated entries are inserted", () => {
    const original = buildWorkspaceTree(entries);
    const updated = buildWorkspaceTree([
      { name: ".env", relativePath: ".env", isDirectory: false, depth: 0 },
      ...entries,
    ]);

    expect(updated.find((node) => node.entry.name === "src")?.id).toBe(original[0].id);
    expect(updated.find((node) => node.entry.name === "README.md")?.id).toBe(original[5].id);
  });
});
