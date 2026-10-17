#!/bin/sh
# install-git-hooks.sh — 在本仓库安装 git 钩子（仓库本地，不动全局配置）。
# 目前只装一个：pre-commit → tools/cn-gate.mjs（中文发布门禁）
set -e
ROOT=$(git rev-parse --show-toplevel)
HOOKS="$ROOT/.git/hooks"
mkdir -p "$HOOKS"

cat > "$HOOKS/pre-commit" <<'HOOK'
#!/bin/sh
# 中文发布门禁：对暂存区里新增/修改的 content/posts/*.md 跑 tools/cn-gate.mjs
# 需要跳过时：git commit --no-verify
ROOT=$(git rev-parse --show-toplevel)
GATE="$ROOT/tools/cn-gate.mjs"
[ -f "$GATE" ] || exit 0
command -v node >/dev/null 2>&1 || { echo "[cn-gate] 没找到 node，跳过门禁"; exit 0; }

FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^content/posts/.*\.md$' || true)
[ -z "$FILES" ] && exit 0

fail=0
for f in $FILES; do
  echo ""
  if ! node "$GATE" --gate "$ROOT/$f"; then fail=1; fi
done
if [ "$fail" = "1" ]; then
  echo ""
  echo "❌ 中文发布门禁未通过：按上面的「改法」修稿后重新提交；确需跳过用 git commit --no-verify"
  exit 1
fi
echo "✅ 中文发布门禁通过"
exit 0
HOOK

chmod +x "$HOOKS/pre-commit"
echo "已安装：$HOOKS/pre-commit"
