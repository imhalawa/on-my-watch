# Contributing

Thanks for helping. on-my-watch is still under development, so bug reports are as welcome as code.

## Report a problem

- [Open an issue](https://github.com/imhalawa/on-my-watch/issues/new/choose) and pick a template.
- Include your OS, your Claude Code version, and the last lines of `~/.on-my-watch/run.log`.
- Remove anything private first: service names, queries, repository names, URLs.
- Report security problems privately. See [SECURITY.md](SECURITY.md).

## Change the code

1. Fork the repository and create a branch from `main`.
2. Read [architecture.md](architecture.md) for how the parts fit.
3. Write a failing test first, then the change that makes it pass.
4. Run every check:
   ```bash
   python3 -B -m unittest discover -s tests
   claude plugin test .
   claude plugin validate .
   ```
5. Open a pull request against `main` and fill in the template.

## Keep it small

- One change per pull request.
- No new dependencies unless there is no other way. The engine uses only the Python standard library.
- Example data stays made up: `acme/*` repositories and plain first names.

## Conduct

Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).
