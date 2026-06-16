# Stage 1: Documentation Site

Part of [Stage 1](../stage-01-contracts.md). Topic-based documentation lives in `docs/` as Markdown, rendered with MkDocs Material and published to GitHub Pages. Developers read the same files in the repo that students browse on the site.

## Audiences and structure

The site serves two audiences with different needs: students using the template to write agents, and developers of this repository. MkDocs Material's `navigation.tabs` gives each a top-level tab. The specification gets a third tab of its own (see below).

```
docs/
  index.md                      what Game Sandbox is, who each tab is for
  students/
    index.md                    stub: points at Stage 2, links the template repo
    getting-started.md          stub (content arrives with Stage 2)
    agent-interface.md          stub (content arrives with Stage 2)
    submitting.md               stub (content arrives with Stage 5)
  contributors/
    index.md                    repo orientation, monorepo map, links to specs/ and plans/
    development-setup.md        uv, npm, scripts, running checks and tests,
                                Windows notes, reproducing CI under WSL
    state-schema.md             the contract, version semantics, the sidecar rule
    recordings.md               JSONL format, header, store interface, the S3 seam
    examples-and-template.md    overlay convention, tag scheme, how publishing works
```

At the end of Stage 1 the home page and the five contributor pages are real. The student pages exist as honest stubs that name the stage delivering their content. This keeps the navigation shape stable from day one, so links from the placeholder template README never break.

## The specification tab

The specification under `specs/` is rendered on the site as its own top-level tab, alongside the student and contributor tabs. The files are not duplicated. `specs/` remains the only editable source, and a small MkDocs hook injects every `specs/*.md` file into the site under `specs/` at build time. The hook is a Python file referenced from `mkdocs.yml` through the `hooks` option. It keeps `mkdocs build` and `mkdocs serve` self-contained, with no copy step to forget. Because the spec files cross-link each other with plain relative links, they render unchanged as a flat section, and the strict build verifies every link inside them just as it does for docs pages.

The tabs divide labor cleanly. Spec pages describe what the system is. Docs pages are operational guides: how to set up, how the contract behaves in practice, and how publishing works. Where a docs page touches design, it links to the rendered spec page rather than restating it. The one normative exception is `contributors/state-schema.md`, which is the public home of the version rule and the sidecar rule from [state-schema.md](state-schema.md). The schema files carry descriptions, and `schema/README.md` is a pointer to the docs page.

## Publishing

`.github/workflows/docs.yml` has two triggers. On pull requests touching `docs/**` or `mkdocs.yml`, it runs `uv run --group docs mkdocs build --strict`, so broken links and bad references fail the PR. On pushes to main, it builds and publishes through the official Pages actions (`actions/upload-pages-artifact` then `actions/deploy-pages`). There is no `gh-pages` branch and no `mkdocs gh-deploy`, so the repo stays single-branch and Pages environment protection applies. One-time setup: enable Pages on the repository with "GitHub Actions" as the source.

Deployment is temporarily disabled while the documentation site is not yet public. The `deploy` job in `docs.yml` is commented out, so pushes to main still build strictly (proving the site is publishable) but nothing is pushed to Pages. Re-enabling is a two-line operation captured in the workflow's own comment — uncomment the job and enable Pages — done when the site goes public.
