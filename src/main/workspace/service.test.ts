import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceService } from './service';

const exec = promisify(execFile);

test('workspace traversal and symlinks cannot inherit external attachment grants', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'omp-workspace-boundary-'));
  try {
    const root = path.join(temporary, 'work');
    const sibling = path.join(temporary, 'work-sibling');
    await mkdir(root); await mkdir(sibling);
    await writeFile(path.join(root, 'inside.txt'), 'inside');
    const outside = path.join(sibling, 'outside.txt');
    await writeFile(outside, 'external attachment');
    await symlink(sibling, path.join(root, 'escape'));
    await symlink(path.join(root, 'inside.txt'), path.join(root, 'internal-link'));
    const service = new WorkspaceService();
    assert.equal((await service.readFile(root, 'internal-link')).content, 'inside');
    await assert.rejects(service.readFile(root, '../work-sibling/outside.txt'), /outside/);
    await assert.rejects(service.readFile(root, 'escape/outside.txt'), /escapes/);
    await assert.rejects(service.listFiles(root, 'escape'), /escapes/);
    assert.deepEqual((await service.searchFiles(root, 'outside')).entries.map(entry => entry.path), []);
    const [attachment] = await service.authorizeAttachments(root, [outside]);
    await writeFile(outside, 'changed after picker');
    const prompt = await service.preparePrompt(root, { text: 'Explain', attachmentIds: [attachment.id] });
    assert.match(prompt.message, /external attachment/);
    assert.doesNotMatch(prompt.message, /changed after picker/);
    await assert.rejects(service.readFile(root, outside), /outside/);
    await assert.rejects(service.preparePrompt(sibling, { text: '', attachmentIds: [attachment.id] }), /another workspace/);
    await service.removeAttachment(attachment.id);
    await assert.rejects(service.preparePrompt(root, { text: '', attachmentIds: [attachment.id] }), /expired/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('attachments reject binary and oversized text atomically and produce native images', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-workspace-attachments-'));
  try {
    const service = new WorkspaceService();
    const binary = path.join(root, 'binary.bin');
    const big = path.join(root, 'big.txt');
    const image = path.join(root, 'pixel.png');
    await writeFile(binary, Buffer.from([0, 1, 2]));
    await writeFile(big, 'a'.repeat(2 * 1024 * 1024 + 1));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8msAAAAASUVORK5CYII=', 'base64');
    await writeFile(image, png);
    assert.equal((await service.readFile(root, binary)).kind, 'binary');
    assert.equal((await service.readFile(root, big)).kind, 'tooLarge');
    await assert.rejects(service.authorizeAttachments(root, [image, binary]), /binary/);
    await assert.rejects(service.authorizeAttachments(root, [big]), /2 MiB/);
    const [attachment] = await service.authorizeAttachments(root, [image]);
    const prompt = await service.preparePrompt(root, { text: 'Describe', attachmentIds: [attachment.id] });
    assert.deepEqual(prompt.images, [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
    assert.equal(prompt.message, 'Describe');
    assert.equal(attachment.path, await realpath(image));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git review separates staged and unstaged state and treats pathspec syntax literally', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-workspace-git-'));
  const service = new WorkspaceService();
  try {
    assert.equal((await service.gitDiff(root)).available, false);
    const git = (...args: string[]) => exec('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    await git('init');
    const subdir = path.join(root, 'nested'); await mkdir(subdir);
    await writeFile(path.join(subdir, 'file.txt'), 'original\n');
    await writeFile(path.join(subdir, '*.txt'), 'literal\n');
    await git('add', '.');
    await git('-c', 'user.name=Workspace Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
    assert.deepEqual((await service.gitDiff(root)).files, []);
    await writeFile(path.join(subdir, 'file.txt'), 'staged\n'); await git('add', 'nested/file.txt');
    await writeFile(path.join(subdir, 'file.txt'), 'unstaged\n');
    await writeFile(path.join(subdir, '*.txt'), 'literal changed\n');
    const diff = await service.gitDiff(subdir, 'file.txt');
    assert.deepEqual(diff.files.map(file => [file.path, file.status]), [['file.txt', 'unstaged M'], ['file.txt', 'staged M']]);
    assert.match(diff.files[0].patch, /\+unstaged/); assert.match(diff.files[1].patch, /\+staged/);
    assert.deepEqual((await service.gitDiff(subdir, '*.txt')).files.map(file => file.path), ['*.txt']);
    await rm(path.join(subdir, '*.txt'));
    assert.equal((await service.gitDiff(subdir, '*.txt')).files[0].status, 'unstaged D');
    await assert.rejects(service.gitDiff(subdir, '../outside'), /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('clipboard image grants preserve accepted bytes, reject invalid additions, and expire', async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-workspace-clipboard-'));
  context.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    const service = new WorkspaceService();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8msAAAAASUVORK5CYII=', 'base64');
    const expected = png.toString('base64');
    const attachment = await service.addImageAttachment(root, { name: 'clipboard.png', mimeType: 'image/png', data: png });
    assert.equal(attachment.source, 'clipboard');
    assert.equal(attachment.path, undefined);
    assert.equal(attachment.previewUrl, `data:image/png;base64,${expected}`);
    assert.equal(attachment.expiresAt, Date.now() + 30 * 60 * 1000);
    await assert.rejects(service.addImageAttachment(root, { name: 'wrong.png', mimeType: 'image/jpeg', data: png }), /MIME type/);
    await assert.rejects(service.addImageAttachment(root, { name: 'bad.png', mimeType: 'image/png', data: Buffer.from('not an image') }), /MIME type/);
    await assert.rejects(service.addImageAttachment(root, { name: 'huge.png', mimeType: 'image/png', data: new Uint8Array(10 * 1024 * 1024 + 1) }), /10 MiB/);
    png.fill(0);
    const prompt = await service.preparePrompt(root, { text: 'draft survives', attachmentIds: [attachment.id] });
    assert.deepEqual(prompt, { message: 'draft survives', images: [{ type: 'image', mimeType: 'image/png', data: expected }] });
    context.mock.timers.setTime(attachment.expiresAt);
    await assert.rejects(service.preparePrompt(root, { text: 'draft survives', attachmentIds: [attachment.id] }), /expired/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file search retains partial matches, scopes paths, and gives bounded root guidance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omp-workspace-search-'));
  try {
    const service = new WorkspaceService();
    await mkdir(path.join(root, 'many'));
    await mkdir(path.join(root, 'target'));
    await writeFile(path.join(root, 'root.txt'), 'root');
    await writeFile(path.join(root, 'target', 'needle.txt'), 'scoped');
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(path.join(root, 'many', `match-${index}.txt`), 'match')));
    const partial = await service.searchFiles(root, 'many/match');
    assert.equal(partial.entries.length, 500);
    assert.equal(partial.truncated, true);
    assert.ok(partial.diagnostics.some(message => message.includes('500')));
    assert.ok(partial.entries.every(entry => entry.path.startsWith('many/match-')));
    const scoped = await service.searchFiles(root, 'target/needle');
    assert.deepEqual(scoped.entries.map(entry => entry.path), ['target/needle.txt']);
    assert.equal(scoped.truncated, false);
    const empty = await service.searchFiles(root, '');
    assert.deepEqual(empty.entries.map(entry => entry.path), ['root.txt']);
    assert.ok(empty.diagnostics.some(message => message.includes('root files')));
    const outside = await service.searchFiles(root, '../');
    assert.deepEqual(outside.entries, []);
    assert.equal(outside.truncated, true);
    assert.ok(outside.diagnostics.some(message => message.includes('outside')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
