# Integrity Rules

1. Claim only behaviors that were executed and observed in this workspace or session.
2. For every behavior claim, include evidence references: command(s) run, pass or fail status, and
   artifact or test path.
3. Label evidence state explicitly as `VERIFIED`, `PARTIALLY VERIFIED`, or `UNVERIFIED`.
4. If any required validation command fails, do not claim completion; report failure and remaining
   gap.
5. Never fabricate command output, benchmark values, logs, or test outcomes.
6. If environment limits prevent verification, state the exact blocker and the specific
   commands or artifacts still pending.
