import { describe, expect, test, vi } from 'vitest';
import { FakeGitHubBoard, OctokitGitHubBoard, UnknownStatusOptionError, type ProjectInfo } from '../src/githubBoard.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const urlOf = (u: Request | string | URL) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url);
type Call = [Request | string | URL, RequestInit | undefined];
const bodyOf = (call: unknown) => JSON.parse(String((call as Call)[1]?.body)) as { query: string; variables: Record<string, unknown> };
const board = (fetchStub: unknown) => new OctokitGitHubBoard('t', { fetch: fetchStub as typeof fetch });

const info: ProjectInfo = { projectId: 'P1', statusFieldId: 'F1', options: [{ id: 'o1', name: 'Todo' }, { id: 'o2', name: 'Done' }] };

const issueNode = (number: number) => ({
  __typename: 'Issue', number, id: `I${number}`, title: `t${number}`, body: `b${number}`, state: 'OPEN', stateReason: null,
  updatedAt: '2026-11-01T00:00:00Z', labels: { nodes: [{ name: 'factory' }] }, repository: { owner: { login: 'o' }, name: 'r' },
});

describe('OctokitGitHubBoard', () => {
  test('tokenScopes parses the x-oauth-scopes header', async () => {
    const fetchStub = vi.fn(async () => json({ login: 'u' }, 200, { 'x-oauth-scopes': 'repo, project, read:org' }));
    expect(await board(fetchStub).tokenScopes()).toEqual(['repo', 'project', 'read:org']);
    expect(urlOf((fetchStub.mock.calls[0] as unknown as Call)[0])).toMatch(/\/user$/);
  });

  test('tokenScopes is null without the header', async () => {
    const fetchStub = vi.fn(async () => json({ login: 'u' }));
    expect(await board(fetchStub).tokenScopes()).toBeNull();
  });

  test('tokenScopes is empty for an empty header', async () => {
    const fetchStub = vi.fn(async () => json({ login: 'u' }, 200, { 'x-oauth-scopes': '' }));
    expect(await board(fetchStub).tokenScopes()).toEqual([]);
  });

  test('project reads the id, the Status field and its options', async () => {
    const fetchStub = vi.fn(async () =>
      json({ data: { repositoryOwner: { projectV2: { id: 'P1', field: { id: 'F1', options: [{ id: 'o1', name: 'Todo' }] } } } } }),
    );
    const p = await board(fetchStub).project({ owner: 'example-org', number: 3 });
    expect(p).toEqual({ projectId: 'P1', statusFieldId: 'F1', options: [{ id: 'o1', name: 'Todo' }] });
    const call = fetchStub.mock.calls[0] as unknown as Call;
    expect(urlOf(call[0])).toMatch(/\/graphql$/);
    expect(bodyOf(call).variables).toEqual({ owner: 'example-org', number: 3 });
  });

  test.each([
    ['no owner', { repositoryOwner: null }],
    ['no project', { repositoryOwner: { projectV2: null } }],
  ])('project is null with %s', async (_label, data) => {
    const fetchStub = vi.fn(async () => json({ data }));
    expect(await board(fetchStub).project({ owner: 'o', number: 3 })).toBeNull();
  });

  test('project is null on a NOT_FOUND GraphQL error', async () => {
    const fetchStub = vi.fn(async () =>
      json({ data: { repositoryOwner: { projectV2: null } }, errors: [{ type: 'NOT_FOUND', path: ['repositoryOwner', 'projectV2'], message: 'no project' }] }),
    );
    expect(await board(fetchStub).project({ owner: 'o', number: 3 })).toBeNull();
  });

  test('listItems reads every page and skips drafts and pull requests', async () => {
    const pages = [
      { nodes: [
        { id: 'IT1', fieldValueByName: { name: 'Todo' }, content: issueNode(1) },
        { id: 'IT2', fieldValueByName: null, content: { __typename: 'DraftIssue' } },
      ], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      { nodes: [
        { id: 'IT3', fieldValueByName: null, content: { __typename: 'PullRequest' } },
        { id: 'IT4', fieldValueByName: null, content: { ...issueNode(4), state: 'CLOSED', stateReason: 'NOT_PLANNED' } },
      ], pageInfo: { hasNextPage: false, endCursor: 'c2' } },
    ];
    let n = 0;
    const fetchStub = vi.fn(async () => json({ data: { node: { items: pages[n++] } } }));
    const items = await board(fetchStub).listItems(info);
    expect(items).toEqual([
      { itemId: 'IT1', status: 'Todo', issue: {
        repo: { owner: 'o', repo: 'r' }, number: 1, nodeId: 'I1', title: 't1', body: 'b1', state: 'open', stateReason: null,
        labels: ['factory'], updatedAt: '2026-11-01T00:00:00Z',
      } },
      { itemId: 'IT4', status: null, issue: expect.objectContaining({ number: 4, state: 'closed', stateReason: 'not_planned' }) },
    ]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchStub.mock.calls[0]).variables).toMatchObject({ id: 'P1', after: null });
    expect(bodyOf(fetchStub.mock.calls[1]).variables).toMatchObject({ id: 'P1', after: 'c1' });
    expect(bodyOf(fetchStub.mock.calls[0]).query).toContain('labels(first: 100)');
  });

  test('listItems maps an unknown stateReason such as DUPLICATE to null', async () => {
    const page = { nodes: [{ id: 'IT1', fieldValueByName: null, content: { ...issueNode(1), state: 'CLOSED', stateReason: 'DUPLICATE' } }],
      pageInfo: { hasNextPage: false, endCursor: null } };
    const fetchStub = vi.fn(async () => json({ data: { node: { items: page } } }));
    const [item] = await board(fetchStub).listItems(info);
    expect(item!.issue).toMatchObject({ state: 'closed', stateReason: null });
  });

  test('setStatus with an unknown option rejects before any network call', async () => {
    const fetchStub = vi.fn();
    await expect(board(fetchStub).setStatus(info, 'IT1', 'todo')).rejects.toBeInstanceOf(UnknownStatusOptionError);
    await expect(board(fetchStub).setStatus(info, 'IT1', 'todo')).rejects.toThrow('Project has no Status option "todo"');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('setStatus sends the option id', async () => {
    const fetchStub = vi.fn(async () => json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'IT1' } } } }));
    await board(fetchStub).setStatus(info, 'IT1', 'Todo');
    const { query, variables } = bodyOf(fetchStub.mock.calls[0]);
    expect(query).toContain('updateProjectV2ItemFieldValue');
    expect(variables).toMatchObject({ project: 'P1', item: 'IT1', field: 'F1', singleSelectOptionId: 'o1' });
  });

  test('Octokit addLabels posts to the labels endpoint', async () => {
    const fetchStub = vi.fn(async (_u: Request | string | URL, _i?: RequestInit) => json([{ name: 'factory' }]));
    await board(fetchStub).addLabels({ owner: 'o', repo: 'r' }, 7, ['factory']);
    const [url, init] = fetchStub.mock.calls[0] as Call;
    expect(urlOf(url)).toMatch(/\/repos\/o\/r\/issues\/7\/labels$/);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ labels: ['factory'] });
  });

  test('listItems skips null nodes', async () => {
    const page = { nodes: [null, { id: 'IT1', fieldValueByName: null, content: null }, { id: 'IT2', fieldValueByName: null, content: issueNode(2) }], pageInfo: { hasNextPage: false, endCursor: null } };
    const fetchStub = vi.fn(async () => json({ data: { node: { items: page } } }));
    const items = await board(fetchStub).listItems(info);
    expect(items.map((i) => i.itemId)).toEqual(['IT2']);
  });

  test('listComments compares since as dates', async () => {
    const comments = [
      { id: 1, user: { login: 'a' }, body: 'x', created_at: '2026-11-15T10:00:00Z' },
      { id: 2, user: { login: 'a' }, body: 'y', created_at: '2026-11-15T10:00:01.500Z' },
    ];
    const fetchStub = vi.fn(async () => json(comments));
    const got = await board(fetchStub).listComments({ owner: 'o', repo: 'r' }, 1, '2026-11-15T10:00:00.000Z');
    expect(got.map((c) => c.id)).toEqual([2]);
  });

  test('closeIssue patches the issue with its state reason', async () => {
    const fetchStub = vi.fn(async (_u: Request | string | URL, _i?: RequestInit) => json({ number: 5 }));
    await board(fetchStub).closeIssue({ owner: 'o', repo: 'r' }, 5, 'not_planned');
    const [url, init] = fetchStub.mock.calls[0] as Call;
    expect(urlOf(url)).toMatch(/\/repos\/o\/r\/issues\/5$/);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ state: 'closed', state_reason: 'not_planned' });
  });
});

describe('FakeGitHubBoard', () => {
  const r = { owner: 'o', repo: 'r' };

  test('create, add to project and set status show in listItems', async () => {
    const fake = new FakeGitHubBoard();
    const p = fake.addProject({ owner: 'o', number: 1 }, ['Todo', 'Done']);
    expect(await fake.project({ owner: 'O', number: 1 })).toEqual(p);
    const { number, nodeId } = await fake.createIssue(r, { title: 'T', body: 'B', labels: ['factory'] });
    const itemId = await fake.addToProject(p, nodeId);
    expect(await fake.addToProject(p, nodeId)).toBe(itemId);
    await fake.setStatus(p, itemId, 'Todo');
    const items = await fake.listItems(p);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId, status: 'Todo', issue: { number, labels: ['factory'], title: 'T', state: 'open' } });
    expect(fake.issue({ owner: 'O', repo: 'R' }, number).itemStatus).toBe('Todo');
    expect(await fake.listItems(fake.addProject({ owner: 'o', number: 2 }, ['Todo']))).toEqual([]);
  });

  test('setStatus with the wrong case rejects', async () => {
    const fake = new FakeGitHubBoard();
    const p = fake.addProject({ owner: 'o', number: 1 }, ['Todo']);
    const { nodeId } = await fake.createIssue(r, { title: 'T', body: 'B', labels: [] });
    const itemId = await fake.addToProject(p, nodeId);
    await expect(fake.setStatus(p, itemId, 'todo')).rejects.toBeInstanceOf(UnknownStatusOptionError);
  });

  test('listComments with since returns only newer comments', async () => {
    const fake = new FakeGitHubBoard();
    const { number } = await fake.createIssue(r, { title: 'T', body: 'B', labels: [] });
    const a = await fake.addComment(r, number, 'one');
    const b = await fake.addComment(r, number, 'two', 'someone');
    expect(b.author).toBe('someone');
    expect(a.author).toBe('octo-user');
    expect(await fake.listComments(r, number)).toEqual([a, b]);
    expect(await fake.listComments(r, number, a.createdAt)).toEqual([b]);
  });

  test('addLabels keeps existing labels', async () => {
    const fake = new FakeGitHubBoard();
    const { number } = await fake.createIssue(r, { title: 'T', body: 'B', labels: ['bug'] });
    await fake.addLabels(r, number, ['factory']);
    expect(fake.issue(r, number).labels).toEqual(['bug', 'factory']);
    await fake.addLabels(r, number, ['factory']);
    expect(fake.issue(r, number).labels).toEqual(['bug', 'factory']);
  });

  test('listComments compares since as dates', async () => {
    const fake = new FakeGitHubBoard();
    const { number } = await fake.createIssue(r, { title: 'T', body: 'B', labels: [] });
    const cs = fake.issue(r, number).comments;
    cs.push({ id: 1, author: 'a', body: 'x', createdAt: '2026-11-15T10:00:00Z' }, { id: 2, author: 'a', body: 'y', createdAt: '2026-11-15T10:00:01.500Z' });
    expect((await fake.listComments(r, number, '2026-11-15T10:00:00.000Z')).map((c) => c.id)).toEqual([2]);
  });

  test('issue throws for an unknown issue', () => {
    expect(() => new FakeGitHubBoard().issue(r, 9)).toThrow('unknown issue: o/r#9');
  });
});
