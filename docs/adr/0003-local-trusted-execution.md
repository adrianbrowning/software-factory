# Local execution for trusted repositories

The first version runs locally against owned, trusted TypeScript repositories, using Claude Code through Sandcastle with AWS Bedrock credentials and the pinned `adrianbrowning/abide` fork with a local endpoint. Skills and tool versions are installed from recorded, pinned revisions rather than ambient global state; hosted execution, hostile repositories, other language ecosystems, and other coding agents are deliberately deferred.
