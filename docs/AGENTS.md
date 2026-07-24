# Documentation guide

These instructions apply to public documentation under `docs/` and the canonical student guides at `environments/<env>/environment.md`. The repository-level [agents guide](../agents.md) still applies.

## Write for a named reader

Every page should make its audience clear.

- Student guides assume the reader may be new to Python, Git, GitHub, terminals, and virtual environments. Introduce a concept before asking the reader to use it, and link to the official documentation for deeper help.
- Contributor guides assume programming experience, but not prior knowledge of this repository. Start with the purpose of the subsystem, then explain where its code lives and how to work on it.
- Specifications describe what the system is and the rules it follows. Keep implementation instructions in contributor guides and implementation sequencing in `plans/`.

Do not assume the reader arrived from another page or already knows a repository convention. State prerequisites and important assumptions where they first matter, then link to the fuller explanation.

## Lead with the useful answer

Put the page's purpose, prerequisites, and most common path near the top. Prefer a short table, numbered procedure, or small diagram when it makes a relationship easier to scan.

Remove background that does not help the reader make a decision or complete a task. Keep rationale when it explains a constraint that would otherwise look arbitrary.

When rewriting an existing page, compare the removed text with the replacement. Preserve product rules, safety warnings, exceptions, and context that the intended reader still needs. If that context makes the page cover two distinct jobs, split it into focused pages and cross-link them rather than deleting it.

## Use shared terms and links

Use the same names as the product and specification, especially **environment**, **season**, **agent**, **submission**, **session**, and **recording**. Define a specialized term on first use.

Link instead of duplicating:

- Shared student task instructions belong under `students/`.
- Environment-specific student guides belong at `environments/<env>/environment.md`. MkDocs and the in-app documentation API expose them at virtual `students/environments/<slug>.md` paths. The only source file under `students/environments/` is the hand-authored section index.
- Contributor procedures belong under `contributors/`.
- Product rules belong under `specs/`.
- Build order and implementation status belong under `plans/`.

Use relative links for pages included in the documentation site. For repository files outside `docs/`, use their stable GitHub URL so MkDocs can resolve the link in the published site. Use stable, primary external sources such as Python, GitHub, Git, PettingZoo, NumPy, and uv documentation.

## Keep Markdown readable

- Write natural, direct sentences.
- Do not use em dashes.
- Keep one source line per paragraph. Let the editor soft-wrap.
- Use headings to make long pages scannable.
- Use bullets for parallel facts and numbered lists for ordered work.
- Avoid long sequences of one-sentence bullets when a short paragraph is easier to read.
- Give fenced code blocks a language when one applies.
- Add descriptive link text. Avoid "click here."
- Keep diagrams small and explain the takeaway in nearby text.

Before finishing, run the strict documentation build:

```console
uv run python scripts/ci.py docs
```
