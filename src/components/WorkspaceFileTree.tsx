import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import type { FileEntry } from "../domain/models";
import { Icon } from "./Icon";

interface WorkspaceFileTreeProps {
  entries: readonly FileEntry[];
  label?: string;
}

export interface WorkspaceTreeNode {
  entry: FileEntry;
  id: string;
  parentId: string | null;
  level: number;
  hasChildren: boolean;
  position: number;
  setSize: number;
}

export interface WorkspaceTreeState {
  collapsed: Set<string>;
  activeId: string | null;
}

export function createWorkspaceTreeState(): WorkspaceTreeState {
  return { collapsed: new Set(), activeId: null };
}

export function buildWorkspaceTree(entries: readonly FileEntry[]): WorkspaceTreeNode[] {
  const nodes: WorkspaceTreeNode[] = [];
  const ancestors: Array<{ depth: number; node: WorkspaceTreeNode }> = [];

  entries.forEach((entry, index) => {
    const depth = Number.isFinite(entry.depth) ? Math.max(0, entry.depth) : 0;
    while (ancestors.length && ancestors[ancestors.length - 1].depth >= depth) ancestors.pop();
    const parent = [...ancestors].reverse().find(({ node }) => node.entry.isDirectory)?.node ?? null;
    const node: WorkspaceTreeNode = {
      entry,
      id: `${entry.relativePath}\u0000${index}`,
      parentId: parent?.id ?? null,
      level: (parent?.level ?? 0) + 1,
      hasChildren: false,
      position: 0,
      setSize: 0,
    };
    nodes.push(node);
    if (entry.isDirectory) ancestors.push({ depth, node });
  });

  const siblingGroups = new Map<string | null, WorkspaceTreeNode[]>();
  nodes.forEach((node) => {
    const siblings = siblingGroups.get(node.parentId) ?? [];
    siblings.push(node);
    siblingGroups.set(node.parentId, siblings);
    if (node.parentId) {
      const parent = nodes.find((candidate) => candidate.id === node.parentId);
      if (parent) parent.hasChildren = true;
    }
  });
  siblingGroups.forEach((siblings) => siblings.forEach((node, index) => {
    node.position = index + 1;
    node.setSize = siblings.length;
  }));

  return nodes;
}

export function visibleWorkspaceNodes(nodes: readonly WorkspaceTreeNode[], collapsed: ReadonlySet<string>): WorkspaceTreeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    let parentId = node.parentId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent) break;
      if (collapsed.has(parent.id)) return false;
      parentId = parent.parentId;
    }
    return true;
  });
}

export function transitionWorkspaceTree(
  nodes: readonly WorkspaceTreeNode[],
  state: WorkspaceTreeState,
  nodeId: string,
  key: string,
): WorkspaceTreeState {
  const visible = visibleWorkspaceNodes(nodes, state.collapsed);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return state;
  const index = visible.findIndex((candidate) => candidate.id === node.id);
  const collapsed = new Set(state.collapsed);
  let activeId = node.id;
  const isCollapsed = collapsed.has(node.id);

  switch (key) {
    case "ArrowDown": activeId = visible[Math.min(index + 1, visible.length - 1)]?.id ?? node.id; break;
    case "ArrowUp": activeId = visible[Math.max(index - 1, 0)]?.id ?? node.id; break;
    case "Home": activeId = visible[0]?.id ?? node.id; break;
    case "End": activeId = visible[visible.length - 1]?.id ?? node.id; break;
    case "ArrowRight":
      if (!node.hasChildren) break;
      if (isCollapsed) collapsed.delete(node.id);
      else activeId = nodes.find((candidate) => candidate.parentId === node.id)?.id ?? node.id;
      break;
    case "ArrowLeft":
      if (node.hasChildren && !isCollapsed) collapsed.add(node.id);
      else activeId = node.parentId ?? node.id;
      break;
    case "Enter":
    case " ":
      if (node.hasChildren) {
        if (isCollapsed) collapsed.delete(node.id);
        else collapsed.add(node.id);
      }
      break;
    default: return state;
  }
  return { collapsed, activeId };
}

export function WorkspaceFileTree({ entries, label = "Workspace files" }: WorkspaceFileTreeProps) {
  const nodes = useMemo(() => buildWorkspaceTree(entries), [entries]);
  const [treeState, setTreeState] = useState<WorkspaceTreeState>(createWorkspaceTreeState);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const visible = useMemo(() => visibleWorkspaceNodes(nodes, treeState.collapsed), [nodes, treeState.collapsed]);
  const effectiveActiveId = visible.some((node) => node.id === treeState.activeId) ? treeState.activeId : visible[0]?.id ?? null;

  const focusNode = (id: string) => {
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  const applyKey = (node: WorkspaceTreeNode, key: string) => {
    const next = transitionWorkspaceTree(nodes, treeState, node.id, key);
    setTreeState(next);
    if (next.activeId) focusNode(next.activeId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, node: WorkspaceTreeNode) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    applyKey(node, event.key);
  };

  const onFolderClick = (event: MouseEvent<HTMLButtonElement>, node: WorkspaceTreeNode) => {
    if (event.detail === 0) return;
    event.currentTarget.focus();
    setTreeState((current) => transitionWorkspaceTree(nodes, current, node.id, "Enter"));
  };

  return (
    <div className="workspace-file-tree" role="tree" aria-label={label}>
      {visible.map((node) => {
        const isOpen = node.hasChildren && !treeState.collapsed.has(node.id);
        const commonProps = {
          role: "treeitem",
          "aria-level": node.level,
          "aria-posinset": node.position,
          "aria-setsize": node.setSize,
          tabIndex: node.id === effectiveActiveId ? 0 : -1,
          title: node.entry.relativePath,
          className: `workspace-tree-row ${node.entry.isDirectory ? "is-folder" : "is-file"}`,
          style: { "--tree-level": node.level } as CSSProperties,
          onFocus: () => setTreeState((current) => ({ ...current, activeId: node.id })),
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => onKeyDown(event, node),
        };
        const contents = <><span className={`tree-chevron ${isOpen ? "is-open" : ""}`}>{node.hasChildren && <Icon name="chevron" size={12} />}</span><Icon className="tree-entry-icon" name={node.entry.isDirectory ? (isOpen ? "folderOpen" : "folder") : "file"} size={15} /><span className="tree-entry-name">{node.entry.name}</span></>;
        const ref = (element: HTMLElement | null) => { if (element) rowRefs.current.set(node.id, element); else rowRefs.current.delete(node.id); };
        return node.hasChildren ? (
          <button {...commonProps} type="button" aria-expanded={isOpen} key={node.id} ref={ref} onClick={(event) => onFolderClick(event, node)}>{contents}</button>
        ) : (
          <div {...commonProps} key={node.id} ref={ref}>{contents}</div>
        );
      })}
    </div>
  );
}
