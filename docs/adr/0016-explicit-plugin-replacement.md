# Explicit Plugin Replacement

Infolens will reject a local installation when a plugin with the same manifest ID is already installed and direct the user to remove the existing plugin first. The MVP plugin manager handles explicit removal; it does not implement in-place upgrades, automatic rollback, or data migration transactions.
