import { test } from "node:test";
import assert from "node:assert/strict";

const { detectShipCommands, extractCommitMessages, extractPrTextFields } = await import(
  new URL("../lib/ship-detect.ts", import.meta.url).pathname
);

function firstKind(cmd: string) { const s = detectShipCommands(cmd); return s.length > 0 ? s[0].kind : undefined; }

test("detects plain git commit", () => { assert.equal(firstKind("git commit -m 'x'"), "commit"); });
test("detects git push", () => { assert.equal(firstKind("git push origin main"), "push"); });
test("detects gh pr create", () => { assert.equal(firstKind("gh pr create --title x"), "pr-create"); });
test("detects gh pr edit as a gated published-PR mutation", () => {
  assert.equal(firstKind("gh pr edit 123 --title x"), "pr-edit");
  assert.equal(firstKind("gh --repo owner/repo pr edit 123 --body x"), "pr-edit");
  assert.equal(firstKind("eval 'gh pr edit 123 --title x'"), "pr-edit");
  assert.equal(firstKind("${GH} pr edit 123 --title x"), "pr-edit");
});
test("detects gh pr create with -R / --repo / --repo= / -Rcompact repo flags", () => {
  assert.equal(firstKind("gh -R owner/repo pr create"), "pr-create");
  assert.equal(firstKind("gh --repo owner/repo pr create"), "pr-create");
  assert.equal(firstKind("gh --repo=owner/repo pr create"), "pr-create");
  assert.equal(firstKind("gh -Rowner/repo pr create"), "pr-create");
});

test("absolute-path wrappers + shell prefixes + exec wrappers are detected", () => {
  assert.equal(firstKind("/usr/bin/sudo git commit"), "commit");
  assert.equal(firstKind("/usr/bin/nohup git push"), "push");
  assert.equal(firstKind("! git push"), "push");
  assert.equal(firstKind("(git push)"), "push");
  assert.equal(firstKind("{ git commit -m x; }"), "commit");
  assert.equal(firstKind(">out git commit -m x"), "commit");
  assert.equal(firstKind("nice git push"), "push");
  assert.equal(firstKind("timeout 30 git push"), "push");
  assert.equal(firstKind("setsid git commit"), "commit");
});

test("aggressive scan does NOT false-positive on data/argument positions", () => {
  for (const c of [
    'echo "git commit"', 'grep "git push" file', "git log --grep commit",
    'printf "%s\\n" "gh pr create"', "sudo systemctl restart",
    "env NODE_ENV=prod npm test", "cat git-commit-notes.txt",
  ]) {
    assert.equal(detectShipCommands(c).length, 0, c);
  }
});

test("extractPrTextFields pulls --title/--body/-t/-b in all forms", () => {
  assert.deepEqual(extractPrTextFields('gh pr create --title "T" --body "B"'), ["T", "B"]);
  assert.deepEqual(extractPrTextFields("gh pr create -t 'title' -b 'body'"), ["title", "body"]);
  assert.deepEqual(extractPrTextFields("gh pr create --title=Fix --body=Details"), ["Fix", "Details"]);
  assert.deepEqual(extractPrTextFields("gh pr create"), []);
});
test("extractPrTextFields does NOT match longer options (--template/--body-file)", () => {
  assert.deepEqual(extractPrTextFields("gh pr create --template=X.md"), []);
  assert.deepEqual(extractPrTextFields("gh pr create --body-file=notes.md"), []);
});
test("extractPrTextFields catches compact short-option form -tVALUE/-bVALUE (like -mmsg)", () => {
  assert.deepEqual(extractPrTextFields("gh pr create -tTitle -bBody"), ["Title", "Body"]);
  assert.deepEqual(extractPrTextFields("gh pr create -t中文 -b正文"), ["中文", "正文"]);
});
test("extractPrTextFields catches clustered BOOLEAN+value short flags (-dt<title>)", () => {
  // gh pr create booleans are -d/-e/-f/-w; `-dt<title>` = `-d -t <title>`.
  assert.deepEqual(extractPrTextFields("gh pr create -dt中文"), ["中文"]);
  assert.deepEqual(extractPrTextFields("gh pr create -db正文"), ["正文"]);
  assert.deepEqual(extractPrTextFields("gh pr create -wdt中文"), ["中文"]);
});
test("extractPrTextFields does NOT misread a value-shorthand's argument as title/body", () => {
  // -l (label) / -a (assignee) take a value; `-lt中文` is label "t中文", not a title.
  assert.deepEqual(extractPrTextFields("gh pr create -lt中文"), []);
  assert.deepEqual(extractPrTextFields("gh pr create -at中文"), []);
});
test("gh separate-value global flag (--hostname) doesn't hide pr create", () => {
  assert.equal(firstKind("gh --hostname github.example.com pr create -t X"), "pr-create");
});
test("space-separated redirection target is consumed (> out git commit)", () => {
  assert.equal(firstKind("> out git commit -m x"), "commit");
  assert.equal(firstKind("2> err git push"), "push");
});
test("detects commit/push behind ANY leading git global flags (generic skip)", () => {
  // No-value global flags (present and future) before the subcommand.
  assert.equal(firstKind("git --no-optional-locks commit -m x"), "commit");
  assert.equal(firstKind("git --paginate commit -m x"), "commit");
  assert.equal(firstKind("git -p commit"), "commit");
  assert.equal(firstKind("git --no-advice commit"), "commit");
  assert.equal(firstKind("git --no-lazy-fetch push"), "push");
  // Value-taking flags (separate value) + attached forms + compound.
  assert.equal(firstKind("git -C /path commit"), "commit");
  assert.equal(firstKind("git --namespace ns push"), "push");
  assert.equal(firstKind("git -C x -c a=b --no-pager commit"), "commit");
});
test("separate-value global options (--attr-source/--config-env) don't hide the subcommand", () => {
  assert.equal(firstKind("git --attr-source HEAD commit"), "commit");
  assert.equal(firstKind("git --config-env user.name=HOME commit"), "commit");
  assert.equal(firstKind("git --attr-source HEAD push"), "push");
});
test("fail-closed: an UNKNOWN separate-value global option before commit/push is still caught", () => {
  assert.equal(firstKind("git --futureopt someval commit"), "commit");
  assert.equal(firstKind("git --futureopt someval push"), "push");
});
test("detects inline `-c alias.x=<ship verb>` native-alias bypass (fail-closed)", () => {
  // The resolved subcommand is the alias NAME, not the verb; scan the alias body.
  assert.equal(firstKind('git -c "alias.ship=commit --no-verify -m bypass" ship'), "commit");
  assert.equal(firstKind("git -c alias.s=commit s -m x"), "commit");
  assert.equal(firstKind('git -c "alias.p=push --force" p'), "push");
  assert.equal(firstKind("git -calias.s=commit s"), "commit");           // attached -c form
  assert.equal(firstKind('git -c "alias.x=!git commit -m x" x'), "commit"); // shell-alias body
  // --config-env pulls the alias body from an env var (statically opaque) —
  // fail-closed to commit rather than miss a possible ship.
  assert.equal(firstKind("git --config-env=alias.x=V x"), "commit");
  assert.equal(firstKind("git --config-env alias.x=V x"), "commit");
});
test("native-alias detector is case-insensitive on the config key (git keys are)", () => {
  // Git config section/key names are case-insensitive, so ALIAS.ship actually
  // runs; the detector must match regardless of case.
  assert.equal(firstKind('git -c ALIAS.ship="commit --no-verify" ship'), "commit");
  assert.equal(firstKind("git -c Alias.ship=push ship"), "push");
  assert.equal(firstKind("git -cALIAS.s=commit s"), "commit");
  assert.equal(firstKind("git --config-env=ALIAS.ship=BODY ship"), "commit");
});
test("native-alias detector does NOT false-positive on non-ship aliases or data", () => {
  assert.equal(firstKind("git -c alias.st=status st"), undefined);
  assert.equal(firstKind("git -c core.editor=vim status"), undefined);
  assert.equal(firstKind('echo "git -c alias.x=commit"'), undefined);
  // A real ship verb as the actual subcommand still works alongside a benign -c.
  assert.equal(firstKind("git -c core.editor=vim commit -m ok"), "commit");
});
test("non-ship git subcommands are NOT flagged", () => {
  for (const c of ["git status", "git log --oneline", "git diff HEAD", "git --paginate log", "git log --grep commit", "git config --list"]) {
    assert.equal(detectShipCommands(c).length, 0, c);
  }
});
test("detects commit after cd &&", () => { assert.equal(firstKind("cd foo && git commit -m x"), "commit"); });
test("detects push after ;", () => { assert.equal(firstKind("echo ok; git push"), "push"); });
test("detects with env assignment prefix", () => { assert.equal(firstKind("EDITOR=vim git commit"), "commit"); });
test("detects with git global flags", () => { assert.equal(firstKind("git -C . -c user.name=x commit -m x"), "commit"); });
test("detects absolute-path git", () => { assert.equal(firstKind("/usr/bin/git commit"), "commit"); });
test("detects sudo/command/env wrappers", () => { assert.equal(firstKind("sudo git commit"), "commit"); });
test("git status/diff/log/add are not ship commands", () => {
  for (const c of ["git status", "git diff", "git log", "git add ."]) {
    assert.equal(detectShipCommands(c).length, 0);
  }
});
test("innocuous commands are not flagged", () => { assert.equal(detectShipCommands("ls -la").length, 0); });
test("bash -c wrapped commit is flagged", () => { assert.equal(firstKind("bash -c 'git commit -m x'"), "commit"); });
test("sh -c wrapped push is flagged", () => { assert.equal(firstKind("sh -c 'git push'"), "push"); });
test("eval with gh pr create is flagged", () => { assert.equal(firstKind("eval 'gh pr create'"), "pr-create"); });
test("xargs git commit is flagged", () => { assert.equal(firstKind("echo a | xargs git commit"), "commit"); });
test("command substitution git commit is flagged", () => { assert.equal(firstKind("echo $(git commit -m x)"), "commit"); });
test("backtick substitution git push is flagged", () => { assert.equal(firstKind("echo \`git push\`"), "push"); });
test("herestring bash commit is flagged", () => { assert.equal(firstKind("bash <<< 'git commit -m x'"), "commit"); });
test("piped-to-sh commit is flagged", () => { assert.equal(firstKind("echo 'git commit' | sh"), "commit"); });
test("sudo combined flags -nHu detected", () => { assert.equal(firstKind("sudo -nHu user1 git commit -m x"), "commit"); });
test("wrapper option grammars don't hide the git head (scan-to-command-head)", () => {
  // env/sudo value-taking flags in any form — separate, attached, long — must not
  // shift past the real git command.
  assert.equal(firstKind("env -u HOME git commit"), "commit");
  assert.equal(firstKind("env --unset HOME git push"), "push");
  assert.equal(firstKind("env -S X git push"), "push");
  assert.equal(firstKind("sudo -uroot git commit"), "commit");
  assert.equal(firstKind("sudo -gstaff git push"), "push");
  assert.equal(firstKind("sudo --chdir /tmp git push"), "push");
  assert.equal(firstKind("doas git commit"), "commit");
});
test("wrapper prefix without a ship subcommand is NOT flagged", () => {
  for (const c of ["sudo -u git status", "env GIT_DIR=x git status", "sudo git log"]) {
    assert.equal(detectShipCommands(c).length, 0, c);
  }
});
test("git --git-dir=/path commit detected", () => { assert.equal(firstKind("git --git-dir=/tmp commit -m x"), "commit"); });

test("compound command returns all ship detections", () => {
  const ships = detectShipCommands("git commit -m x && git push");
  assert.equal(ships.length, 2);
  assert.equal(ships[0].kind, "commit");
  assert.equal(ships[1].kind, "push");
});

test("extracts -m double-quoted message", () => {
  assert.deepEqual(extractCommitMessages('git commit -m "hello world"'), ["hello world"]);
});
test("extracts -m single-quoted and multiple -m", () => {
  assert.deepEqual(extractCommitMessages("git commit -m 'title' -m 'body'"), ["title", "body"]);
});
test("extracts --message= form", () => {
  assert.deepEqual(extractCommitMessages("git commit --message=fix"), ["fix"]);
});
test("extracts -m\"msg\" (no-space double-quote) form", () => {
  assert.deepEqual(extractCommitMessages('git commit -m"hello"'), ["hello"]);
});
test("extracts -mmsg (no-space bare word) form", () => {
  assert.deepEqual(extractCommitMessages("git commit -mtitle"), ["title"]);
});
test("no messages → empty array", () => {
  assert.deepEqual(extractCommitMessages("git commit"), []);
});

// ---------------------------------------------------------------------------
// Obfuscation bypass regression (fail-closed): shell reassembles these into a
// real ship command that a naive per-token matcher would miss.

test("bypass: empty-quote splicing g\"\"it commit → commit", () => {
  assert.equal(firstKind('g""it commit -m x'), "commit");
});
test("bypass: single empty-quote g''it push → push", () => {
  assert.equal(firstKind("g''it push"), "push");
});
test("bypass: IFS/param expansion git${IFS}commit → commit", () => {
  assert.equal(firstKind("git${IFS}commit -m x"), "commit");
});
test("bypass: variable-indirected $GIT commit → commit", () => {
  assert.equal(firstKind("$GIT commit -m x"), "commit");
});
test("bypass: ${GH} pr create → pr-create", () => {
  assert.equal(firstKind("${GH} pr create --title x"), "pr-create");
});
test("bypass: env-assigned then $GIT commit → commit", () => {
  assert.equal(firstKind("GIT=git; $GIT commit"), "commit");
});

// No-false-positive guardrail: normal commands with $vars / 'commit'/'push'
// substrings must NOT be flagged as ship.
for (const safe of [
  "echo $HOME",
  "npm run commit-lint",
  "ls ${DIR}",
  "cat $FILE",
  "git status",
  "git diff HEAD",
  'echo "commit your thoughts"',
  "python push_data.py",
  "./deploy.sh $ENV",
]) {
  test(`no false positive: ${safe}`, () => {
    assert.equal(detectShipCommands(safe).length, 0);
  });
}

// Round-2 obfuscation: intra-word quote splicing with CONTENT, not just empties.
test("bypass: g\"i\"t commit (content-quote splice) → commit", () => {
  assert.equal(firstKind('g"i"t commit -m x'), "commit");
});
test("bypass: g'i't push → push", () => {
  assert.equal(firstKind("g'i't push"), "push");
});
test("bypass: g\"\"\"\"it commit (multi empty-quote run) → commit", () => {
  assert.equal(firstKind('g""""it commit'), "commit");
});

// Round-2 no-false-positive: a $var with a ship VERB as an ARGUMENT (not the
// command head) must NOT be flagged.
for (const safe of [
  "echo $HOME commit",
  "printf '%s\\n' $WORD push",
  "echo ${TOPIC} pr create",
]) {
  test(`no false positive (verb as arg): ${safe}`, () => {
    assert.equal(detectShipCommands(safe).length, 0);
  });
}

// Round-3: quote runs at word start/end + backslash-escape splicing.
for (const [cmd, kind] of [
  ['"g"it commit', "commit"],
  ['gi"t" commit', "commit"],
  ["'g'it push", "push"],
  ["gi't' commit", "commit"],
  ['"g""i""t" commit', "commit"],
  ["\\g\\i\\t commit", "commit"],
] as const) {
  test(`bypass: shell-dequoted ${cmd} → ${kind}`, () => {
    assert.equal(firstKind(cmd), kind);
  });
}

// Round-4: $IFS word-splitting glued to quotes, and ${x:=git} default-value
// expansion, both reassemble to a real ship command in the shell.
test("bypass: git$IFS\"commit\" (IFS + quote) → commit", () => {
  assert.equal(firstKind('git$IFS"commit" -m x'), "commit");
});
test("bypass: git$IFS'push' → push", () => {
  assert.equal(firstKind("git$IFS'push'"), "push");
});
test("bypass: ${x:=git} commit (default-value expansion) → commit", () => {
  assert.equal(firstKind("${x:=git} commit -m x"), "commit");
});
test("bypass: adjacent default-value concat ${x:-g}${y:-it} commit → commit", () => {
  assert.equal(firstKind("${x:-g}${y:-it} commit"), "commit");
  assert.equal(firstKind("${x:=g}${y:=it} push"), "push");
});

// Round-5: dynamic command HEAD built from a substitution/variable + ship verb.
for (const [cmd, kind] of [
  ["$(printf git) commit", "commit"],
  ["`printf git` push", "push"],
  ["${GIT_CMD} commit", "commit"],
  ["$(printf gh) pr create", "pr-create"],
] as const) {
  test(`bypass: dynamic head ${cmd} → ${kind}`, () => {
    assert.equal(firstKind(cmd), kind);
  });
}
// Dynamic expression in ARGUMENT position must NOT be flagged.
for (const safe of ['echo "$(date)"', 'printf "%s\\n" "$(git status)"', "echo ${TOPIC} commit", 'npm test -- --seed="$(date +%s)"']) {
  test(`no false positive (dynamic arg): ${safe}`, () => {
    assert.equal(detectShipCommands(safe).length, 0);
  });
}

// Round-3: backslash-newline line continuation must be removed before matching
// (the shell joins the line, so `git \<newline>commit` runs as `git commit`).
test("bypass: backslash-newline continuation → commit", () => {
  assert.equal(firstKind("git \\\ncommit"), "commit");
});
test("bypass: continuation inside a quoted-splice command name", () => {
  assert.equal(firstKind('g"i\\\nt" commit'), "commit");
});
