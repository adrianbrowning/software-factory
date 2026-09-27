# Software Factory

The Software Factory turns one requested repository change into a reviewed, merge-ready result while preserving a human-controlled merge boundary.

## Language

**Issue**:
The canonical GitHub record of one requested outcome and its acceptance criteria. One Factory Run serves exactly one Issue.
_Avoid_: Ticket, prompt, job

**Issue Contract**:
The immutable snapshot of the originating Issue's requested outcome and acceptance criteria that governs its Factory Run and every later remediation.
_Avoid_: Prompt, latest issue text

**Work Item**:
One dependency-aware piece of an Issue produced during decomposition, represented by a GitHub sub-issue, and completed within its Factory Run.
_Avoid_: Subtask, step

**Factory Run**:
One bounded attempt to satisfy an Issue as completely as possible, ending at a merge-ready result or an explicit blocked outcome.
_Avoid_: Session, workflow, pipeline

**Factory Loop**:
The original Factory Run followed by its sequential remediation Factory Runs, all governed by the original Issue Contract and ending at the Merge Boundary.
_Avoid_: Retry loop, pipeline

**PR Layer**:
One independently reviewable change in a dependency-ordered PR Stack.
_Avoid_: Child PR, sub-PR

**PR Stack**:
Two or more dependent PR Layers that collectively satisfy one Issue while remaining reviewable in sequence.
_Avoid_: Mega-PR, branch chain

**Baseline**:
The recorded health of the target repository before a Factory Run changes it.
_Avoid_: Known failures, starting state

**Gate**:
A deterministic repository or policy check whose result contributes evidence that a PR Layer remains healthy.
_Avoid_: Agent opinion, final check

**Gate Failure**:
A structured record that a Gate did not meet its acceptance condition during a Factory Run.
_Avoid_: Error dump, agent feedback

**Review Finding**:
A concrete concern discovered during review that must be evaluated and, when valid, remediated without losing the originating Issue's context.
_Avoid_: Review item, feedback

**Remediation Issue**:
A GitHub issue created for a validated Critical or High Review Finding and resolved in the context of the originating Issue Contract.
_Avoid_: Fix ticket, reviewer task

**Deferred Review Issue**:
One GitHub issue that groups the non-blocking Observations from a Factory Loop for later human consideration.
_Avoid_: Remediation Issue, backlog dump

**Needs Attention**:
A resumable Factory Loop state reached when an execution or review budget is exhausted or a material human decision is required.
_Avoid_: Failed, abandoned

**Merge Ready**:
The state reached when every required Gate and review has passed and no validated Critical or High Review Finding remains.
_Avoid_: Done, merged

**Merge Boundary**:
The point at which the Factory Loop stops and a human decides whether to merge its pull request or PR Stack.
_Avoid_: Approval gate
