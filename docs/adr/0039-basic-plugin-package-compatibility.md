# Basic Plugin Package Compatibility

Every plugin manifest declares a `contractVersion` and a semantic-version `minHostVersion`. Before copying a local package into the managed plugin directory, Infolens verifies that it supports the declared contract version and satisfies the stated minimum host version. It rejects incompatible packages before changing installed plugins and explains the incompatibility.

This is a usability and reliability check, not a security review. Compatible plugins remain trusted by default without permission approval, source-code review, or a governed package transaction.
