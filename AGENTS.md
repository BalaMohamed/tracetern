# TraceTern project instructions

## Authority and scope

- Work only inside the verified TraceTern repository. Never modify, commit, move, or delete another project's files.
- This coding agent is the only agent authorized to modify the repository. Astra/the teaching chat is read-only and supplies technical teaching, not architecture approval.
- Stop at each approved milestone boundary. The repository pivot, architecture and first deterministic replay milestone are authorized. Later milestones require separate approval.

## Mandatory Git safety

- Before changes, verify the repository path; inspect `git status`, `git branch -vv`, `git remote -v`, and every staged, modified, and untracked file.
- Expected origin: `https://github.com/BalaMohamed/tracetern.git`. Stop and ask if it differs; never change remotes without permission.
- Preserve existing work. If another process/session has changed the tree, stop and ask before proceeding. Never overwrite unrelated changes or automatically stash them.
- Never run hard reset, destructive checkout, clean, or other work-discarding commands without explicit approval. Never delete branches automatically.
- Never force-push, including force-with-lease. Never rebase, amend, or rewrite published history without explicit approval. Never resolve conflicts by discarding one side automatically.
- Never modify Git internals directly or change global Git configuration without permission.
- Stage intended paths explicitly; never use indiscriminate `git add .` or `git add -A`.
- Never commit environment files, keys, credentials, secrets, private datasets, or machine-specific files. Review complete staged content for secrets/private information and unrelated changes.
- Run relevant required tests/checks; do not bypass hooks or failing tests. A commit failing required tests must not be pushed without explicit user authorization.
- Inspect remote state before pushing. If it contains commits unavailable locally, stop and explain; never automatically merge, rebase, or overwrite them.
- Use only normal pushes to the verified remote. Verify the expected remote commit afterward.
- Authentication, permissions, divergence, unexpected changes, or potentially destructive steps require stopping and explaining rather than guessing.

## Approved milestone publication

After an approved milestone: inspect existing changes, run relevant checks, review the diff, stage only milestone files, review `git diff --cached`, create one descriptive commit, show the exact commits, files, checks, branch and remote to the user, and ask for push approval. Only after approval, verify remote compatibility, push normally, verify the remote commit, report results, and stop. Report commit hash, files, branch, remote URL, checks, and push outcome.
