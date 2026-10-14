#!/usr/bin/env python3
"""Atlas audit: meta, anchors, cross-repo links, orphans, staleness, size budget, unmapped docs, unabsorbed ADRs.

Run from the directory that holds the tree (repo root or materials dir).
--atlas DIR: where the tree lives, default docs/atlas.
"""
import re, subprocess, pathlib, argparse

ap = argparse.ArgumentParser()
ap.add_argument('--atlas', default='docs/atlas')
args = ap.parse_args()

ROOT = pathlib.Path('.').resolve()
ENTRY = ROOT / 'AGENTS.md'
ATLAS = ROOT / args.atlas
TREE_ROOT = ATLAS / 'README.md'
BUDGET = {'entry': 60, 'node': 250}
nodes = [p for p in [ENTRY, *sorted(ATLAS.rglob('*.md'))] if p.exists()]
SKIP_DIRS = {'.git', '.github', 'node_modules', 'vendor', 'dist', 'build', '.venv', 'venv'}  # .github：issue/PR 模板是平台文件
SKIP_FILES = {'CLAUDE.md', 'AGENTS.md'}  # CLAUDE.md 只含 @AGENTS.md；目录级 AGENTS.md 由 Agent 自动加载
linked, issues = set(), []


def front(p):
    m = re.match(r'---\n(.*?)\n---', p.read_text(encoding='utf-8'), re.S)
    return m.group(1) if m else ''


def field_list(head, key):
    m = re.search(rf'^{key}:\s*\[(.*?)\]', head, re.M)
    return [a.strip() for a in m.group(1).split(',') if a.strip()] if m else []


def field(head, key):
    m = re.search(rf'^{key}:\s*([^\s#]+)', head, re.M)
    return m.group(1) if m else None


for p in nodes:
    text = p.read_text(encoding='utf-8')
    head = front(p)
    rel = p.relative_to(ROOT)

    if p != ENTRY and not field(head, 'kind'):
        issues.append(f'[meta]   {rel}: missing kind in frontmatter')
    budget = BUDGET['entry' if p == ENTRY else 'node']
    lines = text.count('\n')
    if lines > budget:
        issues.append(f'[size]   {rel}: {lines} lines > {budget}')

    # code / source 指向本仓库的代码和资料，相对树根所在目录
    code = field_list(head, 'code')
    for a in [*code, *field_list(head, 'source')]:
        if not (ROOT / a).exists():
            issues.append(f'[anchor] {rel}: missing {a}')

    # atlas / up 指向另一个仓库的节点，相对本文件，且必须互相指向
    for a in field_list(head, 'atlas'):
        t = (p.parent / a).resolve()
        if not t.exists():
            issues.append(f'[atlas]  {rel}: missing {a}')
        elif (t.parent / (field(front(t), 'up') or '')).resolve() != p.resolve():
            issues.append(f'[atlas]  {rel}: {a} has no up: pointing back here')
    up = field(head, 'up')
    if up:
        t = (p.parent / up).resolve()
        if not t.exists():
            issues.append(f'[atlas]  {rel}: missing up {up}')
        elif p.resolve() not in {(t.parent / a).resolve() for a in field_list(front(t), 'atlas')}:
            issues.append(f'[atlas]  {rel}: up {up} does not list this tree in atlas:')

    ver = re.search(r'^verified:.*@\s*([0-9a-f]{7,40})', head, re.M)
    if code and ver:
        r = subprocess.run(['git', 'rev-list', '--count', f'{ver.group(1)}..HEAD', '--', *code],
                           capture_output=True, text=True)
        if r.returncode:
            issues.append(f'[stale?] {rel}: verified commit {ver.group(1)} not found')
        elif int(r.stdout.strip() or 0) > 0:
            issues.append(f'[stale?] {rel}: {r.stdout.strip()} commits touched its code since verified')
    elif code:
        issues.append(f'[stale?] {rel}: no verified commit')

    for link in re.findall(r'\]\(((?!https?:|mailto:|<)[^)\s#]+)', text):
        target = (p.parent / link).resolve()
        if not target.exists():
            issues.append(f'[link]   {rel}: broken link {link}')
        elif target.suffix == '.md' or target.is_dir():
            linked.add(target)

for p in nodes:
    if p not in (ENTRY, TREE_ROOT) and p.resolve() not in linked:
        issues.append(f'[orphan] {p.relative_to(ROOT)}: no node links here')

# 每条有效 ADR 都要被某个 atlas 节点直接引用（链到 docs/adr/ 目录不算）
for p in sorted((ROOT / 'docs/adr').glob('*.md')):
    if re.search(r'^status:\s*(Superseded|Deprecated|Rejected)', p.read_text(encoding='utf-8'), re.M | re.I):
        continue
    if p.resolve() not in linked:
        issues.append(f'[unabsorbed] {p.relative_to(ROOT)}: no atlas node cites this decision')

# 每份文档都要能从 atlas 走到：直接链接到它，或链接到它所在的目录
node_set = {n.resolve() for n in nodes}
for p in sorted(ROOT.rglob('*.md')):
    rp = p.resolve()
    if SKIP_DIRS & set(p.relative_to(ROOT).parts) or p.name in SKIP_FILES or rp in node_set:
        continue
    if rp not in linked and not any(d in rp.parents for d in linked if d.is_dir()):
        issues.append(f'[unmapped] {p.relative_to(ROOT)}: not reachable from atlas document map')

print('\n'.join(issues) or 'atlas OK')
