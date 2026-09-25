# Buildwise — Learning Log

## Purpose

Buildwise is being developed as a learning project as well as a working prototype.

The objective is not to memorize tutorials.

The objective is:

> **Understand what was built, why it was built that way, how the data flows, and what can fail.**

---

# Learning loop

```text
Learn
↓
Explain
↓
Plan
↓
Implement
↓
Run
↓
Test
↓
Inspect code
↓
Teach back
↓
Verify
```

---

# Feature learning template

## Feature

`<name>`

## What I learned

- What is it?
- Why does Buildwise need it?
- What problem does it solve?
- How does data move through it?

## Architecture

```text
...
```

## Files I changed

```text
...
```

## Important code paths

```text
...
```

## What can fail?

```text
...
```

## Security implications

```text
...
```

## What I still do not understand

```text
...
```

## Teach-back

Explain the feature without opening the AI response.

---

# Five-question self-test

For every major feature, I should be able to answer:

1. What is this technology/component?
2. Why did Buildwise need it?
3. What data goes into it?
4. What does it return/change?
5. What happens when it fails?

---

# Tool roles while learning

## ChatGPT

- teach concepts before features
- explain architecture
- quiz after implementation
- review product consistency

## Gemini

- explain Google AI/Cloud concepts
- review ADK/Gemini architecture
- explain Google-specific implementation choices

## Claude Code

- pair-program
- implement
- explain important code paths
- run tests
- fix implementation issues

## Antigravity

- inspect the real running product
- perform browser tests
- simulate users
- attack security boundaries
- verify deployment
- produce verification findings

---

# Rule

Do not ask the tools to replace understanding.

Use them to accelerate understanding.
