# Prose rules (a diff that adds or changes a rule in a skill or agent prompt)

- A new or changed prohibition: does it also block valid cases outside its purpose? Example: a rule against duplicate tests that forbids every new test on an already covered path, including a test that covers a different behavior.
- A new rule that drops or downgrades a finding or verdict: test it against a false-match case where it gives the wrong verdict. Example: a rule that drops a missing-test finding when any test asserts on the message fragment, even when that test does not reach the named path.
