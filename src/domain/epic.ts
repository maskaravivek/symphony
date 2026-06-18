import type { Issue } from './issue.js';

export interface EpicTreeNode {
  issue: Issue;
  children: EpicTreeNode[];
}

export function flattenEpicTree(root: EpicTreeNode): EpicTreeNode[] {
  const out: EpicTreeNode[] = [];
  const visit = (node: EpicTreeNode) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

export function leafEpicNodes(root: EpicTreeNode): EpicTreeNode[] {
  return flattenEpicTree(root).filter((node) => node !== root && node.children.length === 0);
}
