export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface PullRequestRef {
  id: string | null;
  number: number | null;
  url: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  number: number | null;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  workflow_state: string | null;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  blocked_by: BlockerRef[];
  pull_requests: PullRequestRef[];
  created_at: string | null;
  updated_at: string | null;
}

