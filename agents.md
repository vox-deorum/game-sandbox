# Agents Guide

This file is for AI coding agents working on the Game Sandbox repository. It captures the writing style we want and gives a quick orientation to the project. Humans are welcome to read it too.

## About this repo

Game Sandbox is a classwise playground for Game AI. Participants submit agents through GitHub, and everyone can watch those agents, play with or against them, rate them, and see them ranked on per-environment leaderboards. The system is built on PettingZoo, with Shimmy wrapping single-agent games so the rest of the codebase only sees a PettingZoo interface. Web users authenticate with GitHub OAuth, submissions are repo links pinned to a commit and tagged with an iteration, and there are two leaderboards per environment per iteration (automated and human feedback). Unity ML-Agents support is planned for later but not in scope today.

The full specification lives under [specs/](specs/README.md). Read it before changing anything substantive. The implementation plan lives under [plans/](plans/README.md); implementation work must stay connected to it, so when code diverges from a stage file, revise the stage file in the same change set (see the plan README for the rules).

## Writing style

When you write documentation, specs, or any prose in this repo, follow these rules:

- Write naturally, the way a thoughtful human would write a spec. No marketing voice.
- Do not use em-dashes. Use commas, periods, parentheses, or rewording instead.
- Specs describe what the system is. They do not include implementation details, build plans, or code scaffolding unless the task explicitly asks for those.
- Organize clearly with sections and short paragraphs. Avoid bullet soup, which is a wall of single-sentence bullets that could have been a paragraph.
- No emoji.

## Working on this repo

A few defaults that will save back-and-forth:

- Read the relevant files under [specs/](specs/README.md) before proposing changes that touch the design. Start with [specs/overview.md](specs/overview.md).
- Ask before expanding scope. If a request implies new features beyond what is in the spec, raise it rather than quietly adding them.
- Prefer editing existing files over creating new ones.
- Keep specification documents under [specs/](specs/README.md). Each file should have a single clear topic and cross-link to the others rather than duplicating content.
