# Vertical native PR stacks

Large Issues are decomposed into dependency-ordered, independently testable vertical PR Layers and submitted with GitHub's native stacked-PR mechanism behind an adapter. There is no arbitrary layer limit, but every layer must map to acceptance criteria and justify its dependency; this accepts reliance on a public-preview capability in exchange for reviewable changes, while the adapter contains that dependency.
