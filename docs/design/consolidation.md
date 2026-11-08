# Consolidation

A consolidation moves the durable lessons of the tickets just processed into the instructions of the project: `AGENTS.md`, the READMEs of the folders, the skills, the glossary. It is the long memory of the AIs that work on the project. The user starts it by hand, reviews its diff, merges it, and can roll it back. Milestone 19, decided on 2026-11-08: the spec here (#234), the run (#235, done in plugin-kanban and the core), the review and the rollback (#236), the pruning (#237).

The idea comes from *Language Models Need Sleep* (Behrouz et al., [arXiv 2606.03979](https://arxiv.org/abs/2606.03979)). A model with a short memory (its context) and a long memory (its parameters) needs a phase that moves what the short memory learned into the long memory, and prunes the long memory. The IDE does not train a model. It applies the same idea to text: a thread is the short memory, the instructions are the long memory. The paper calls the text-only form *sleep-time compute* and says that it is weaker than a change of weights. It is the form an IDE that calls models by API can have.

## Choices

- **Manual only.** The user starts a consolidation. There is no trigger when the pod is idle.
- **A consolidation is a ticket** of kind `consolidation`. It gets the branch, the worktree, the sessions, *To test*, the merge and *Done* of every ticket. Nothing reaches the base branch before the user merges it.
- **One commit per lesson.** Each commit names the tickets it comes from. The user drops a commit to reject that lesson alone.
- **The rollback is a revert** of the commit that merged the consolidation, in the main folder, never forced.
- **Pruning in the same run.** The run also proposes to merge or remove rules, each in its own commit, so the instructions do not grow without limit.
- **Out of scope for now**: an automatic trigger, and the *dreaming* of the paper (replay past tasks with and without a new rule, keep the rules that improve the result). We decide on them after use.

## Words

- **Consolidation**: a ticket of kind `consolidation`, and the run of its session.
- **Source**: a ticket a consolidation reads. A ticket that is the source of a consolidation, whatever its state, is **consolidated**.
- **Lesson**: one durable fact taken from the sources (a decision, a pitfall, a correction of the user), written as one change of the instructions.

## Start

The Board header has *Consolidate*. It opens a dialog:

- **The candidates**: the tickets of kind `ticket` in *To test* or *Done* that are not consolidated, oldest first, all checked. *Add a ticket…* adds an older or consolidated ticket by its number. A step counts as its own ticket. An abandoned ticket is not a candidate (it can be added by hand).
- **An estimate**: about how many tokens the run reads, per ticket and in total. It is the length of the texts of the ticket (description, plan, how to test, notes, feedback) and of all the messages of its linked conversations and their sub-agents (`Chars` of the `agents.chatTimes` bridge), divided by 4. It is shown as an order of size, not a price. An IDE before this change gives no `Chars`: the estimate then counts the texts only.
- **The past consolidations**: number, date, number of sources, state (*Proposed*, *Merged*, *Rejected*, *Rolled back*), a link to the ticket, and *Roll back* on a merged one.
- *Start* (the assistant) and *Start with Claude Code*, disabled when no ticket is checked.

*Start* creates the ticket, *Consolidation YYYY-MM-DD*, with its sources and the complexity *high* (`kanban.consolidation.create`). Then the page starts it, as *Start development* does: branch `ticket/<n>-consolidation-yyyy-mm-dd` from the base of the kanban, worktree, setup commands, *In progress*, the worktree shown in the window. Then it opens its session, as *Dev session* does: the assistant in Build mode with the role `consolidation` (or the session of the development agent of the kanban settings), or Claude Code with `/mcp__web-ide__consolidate <n>`. The effort is the one of the complexity *high* (Max, Opus): reading many threads and choosing what lasts is the hard part. The ticket view is not opened: its tab would take the place of the Board, whose frame runs the start. In the ticket view of a consolidation, *Dev session* starts the same session again.

## The run

The session reads its ticket (`kanban_get`), which lists the sources. For each source it reads `kanban_get` and its conversations (`kanban_conversation` with `tools`: the errors and the corrections are there), and the diff of its branch when the branch still exists. Then it reads the instructions it may change.

It keeps a lesson only when all of these are true:

1. It will matter again, to another ticket. A detail of one change is not a lesson.
2. The code, the git history and the docs do not say it already. A lesson that belongs in the code (a comment, a test) is a note of the run, not a change of the instructions.
3. It is a fact or a rule, not a story of what happened.
4. It holds no secret, no address of a private machine, no personal data.

Where a lesson goes:

| Lesson | Target |
|---|---|
| A rule for every AI on the whole project (a command, a convention, a thing to never do) | `AGENTS.md` at the root |
| A rule for one folder | the `AGENTS.md` of that folder, else its `README.md` (*Pitfalls*) |
| A fact about how an area works (a map, an invariant, a pitfall) | the `README.md` of the area |
| A procedure of several steps that comes back (a release, a migration) | a skill of the project |
| A word, or a word whose meaning changed | `GLOSSARY.md` |
| A design decision | the page of `docs/design/` |

It writes in the style of the file it changes (the rules of `AGENTS.md`: STE, short, no restatement). Each lesson is one commit, `Consolidation: <the lesson in a few words> (#a, #b)`. It adds a note to its ticket with the lessons it did not keep and why, in a few lines.

**Pruning** (#237): it compares the lessons with the rules already there, and proposes, each in its own commit `Prune: <what> (<reason>)`:

- to merge two rules that say the same thing;
- to remove a rule that a newer decision contradicts, citing the decision (ticket, commit);
- to remove a rule about a path, a name or a command that no longer exists (it checks the repository).

At the end it moves its ticket to *To test*. Its *How to test* lists each commit with its target and its sources, and the size of the instructions before and after (lines). A run with no lesson and nothing to prune makes no commit and says so in its *How to test*; the user abandons it.

## Review, merge, rejection

The ticket view of a consolidation shows its sources (number, title, status) in place of the plan, and the commits of its branch in *Git and changes*, each with **Drop**: `git revert --no-edit <commit>` in the worktree, so the branch keeps the trace. A test feedback (*remove this rule*, *put it in that README*) is handled by a *Fix session* with the role `correction`, as for any ticket. The user can also edit the files in the worktree and commit.

*Merge* and *Done* are those of every ticket. The pod stores the commit the merge made on the base branch (a merge commit, or the squash commit). *Abandon* rejects it: the branch can be deleted, and its sources stay consolidated, so the next run does not offer them again.

## Rollback

*Roll back* is in *More actions* of a merged consolidation (*Done*) and in the list of the dialog. It asks for confirmation, then runs in the main folder, on the local base branch:

- `git revert --no-edit -m 1 <commit>` for a merge commit, `git revert --no-edit <commit>` for a squash commit;
- a conflict stops it. The ticket shows the conflict, as for a merge, and *Resolve* starts a session with the role `resolve`; *Abort* runs `git revert --abort`;
- the pod never forces it, and refuses while the main folder has uncommitted changes in the files the revert touches.

Once the revert is committed, the ticket stays *Done* and gets the state *Rolled back* (a badge on the card, an event in the history with the commit of the revert). Its sources stay consolidated. A rollback cannot be undone from the IDE: a new consolidation can add the tickets again.

## Where the code lives

- **plugin-kanban**: the kind, the sources, the dialog, the ticket view of a consolidation, *Drop*, the rollback, the RPC and the MCP output (`kanban_get` lists the sources).
- **The assistant** (`plugins/ai/engine/texts.go`): the role prompt `consolidation`, a Build session in the worktree like `dev`.
- **Claude Code** (`pod/server/mcp_prompts.go`): the MCP prompt `consolidate`, the same text.

The two prompts share their lines, as the other roles do ([kanban.md](kanban.md#linked-conversations)).

## Storage and API

- `tickets.kind` (`ticket` or `consolidation`), `tickets.merge_commit` (the commit of the merge, stored for every ticket), `tickets.rolled_back` (the time of the rollback, 0 if none), and a table `consolidation_sources (ticket_id, source_id)`.
- RPC: `kanban.consolidation.candidates` (the candidates with their estimate, and the past consolidations; with `id`, that one ticket, for *Add a ticket…*), `kanban.consolidation.create { sources }` (creates the ticket, To do), `kanban.drop { id, commit }`, `kanban.rollback { id }` (and `continue`, `abort` through those of the merge).
- MCP: `kanban_get` lists the sources of a consolidation; no tool starts, merges or rolls back a consolidation (the user's actions).
- `kanban_next` and the Orchestrator never offer a consolidation: it starts when it is created.
