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
  it("renders flattened tree ARIA, sibling positions, and exactly one roving tab stop", () => {
    const markup = renderToStaticMarkup(<WorkspaceFileTree entries={entries} />);

    expect(markup).toContain('role="tree"');
    expect(markup.match(/role="treeitem"/g)).toHaveLength(6);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/aria-expanded="true"/g)).toHaveLength(2);
    expect(markup).toMatch(/aria-level="3" aria-posinset="1" aria-setsize="1"/);
    expect(markup).toMatch(/aria-level="1" aria-posinset="3" aria-setsize="3"[^>]*title="README.md"/);
    expect(markup).toMatch(/<div[^>]*title="empty"/);
  });

  it("navigates Down, Up, Home, and End over visible nodes", () => {
    const nodes = buildWorkspaceTree(entries);
    let state: WorkspaceTreeState = { collapsed: new Set(), activeId: nodes[0].id };
    state = transitionWorkspaceTree(nodes, state, nodes[0].id, "ArrowDown");
    expect(state.activeId).toBe(nodes[1].id);
    state = transitionWorkspaceTree(nodes, state, nodes[1].id, "ArrowUp");
    expect(state.activeId).toBe(nodes[0].id);
    expect(transitionWorkspaceTree(nodes, state, nodes[0].id, "End").activeId).toBe(nodes[5].id);
    expect(transitionWorkspaceTree(nodes, state, nodes[0].id, "Home").activeId).toBe(nodes[0].id);
  });

  it("uses Right to expand or visit the first child and Left to collapse or visit the parent", () => {
    const nodes = buildWorkspaceTree(entries);
    let state: WorkspaceTreeState = { collapsed: new Set([nodes[0].id]), activeId: nodes[0].id };
    state = transitionWorkspaceTree(nodes, state, nodes[0].id, "ArrowRight");
    expect(state.collapsed.has(nodes[0].id)).toBe(false);
    state = transitionWorkspaceTree(nodes, state, nodes[0].id, "ArrowRight");
    expect(state.activeId).toBe(nodes[1].id);
    state = transitionWorkspaceTree(nodes, state, nodes[1].id, "ArrowLeft");
    expect(state.collapsed.has(nodes[1].id)).toBe(true);
    state = transitionWorkspaceTree(nodes, state, nodes[1].id, "ArrowLeft");
    expect(state.activeId).toBe(nodes[0].id);
  });

  it("toggles expandable parents with Enter and Space but leaves end nodes unchanged", () => {
    const nodes = buildWorkspaceTree(entries);
    const initial = createWorkspaceTreeState();
    const entered = transitionWorkspaceTree(nodes, initial, nodes[0].id, "Enter");
    expect(entered.collapsed.has(nodes[0].id)).toBe(true);
    expect(transitionWorkspaceTree(nodes, entered, nodes[0].id, " ").collapsed.has(nodes[0].id)).toBe(false);

    const emptyDirectory = nodes[4];
    const endState = transitionWorkspaceTree(nodes, initial, emptyDirectory.id, "Enter");
    expect(endState.collapsed).toEqual(new Set());
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
    const visible = visibleWorkspaceNodes(nodes, new Set([nodes[0].id]));

    expect(visible.map(({ entry }) => entry.name)).toEqual(["first", "second", "second-child"]);
  });

  it("derives expandability, parents, levels, and sibling sets from represented relationships", () => {
    const nodes = buildWorkspaceTree(entries);

    expect(nodes[0]).toMatchObject({ hasChildren: true, parentId: null, level: 1, position: 1, setSize: 3 });
    expect(nodes[1]).toMatchObject({ hasChildren: true, parentId: nodes[0].id, level: 2, position: 1, setSize: 2 });
    expect(nodes[2]).toMatchObject({ hasChildren: false, parentId: nodes[1].id, level: 3, position: 1, setSize: 1 });
    expect(nodes[4]).toMatchObject({ hasChildren: false, parentId: null, position: 2, setSize: 3 });
  });

  it("creates independent expanded state for a freshly keyed tree instance", () => {
    const first = createWorkspaceTreeState();
    first.collapsed.add("some-node-id");
    const replacement = createWorkspaceTreeState();

    expect(first.collapsed.size).toBe(1);
    expect(replacement).toEqual({ collapsed: new Set(), activeId: null });
    expect(replacement.collapsed).not.toBe(first.collapsed);
  });
});
