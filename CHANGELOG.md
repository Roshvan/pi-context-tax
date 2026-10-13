# Changelog

## 0.2.2

Pi 1.2.0 compatibility release. Version 0.2.1 was tagged but not published to npm.

- Capture context for both user-initiated and custom-message runs. Detect expanded skills only when `before_agent_start` carries a user prompt, preserving compatibility with older Pi versions.
- Pin the development Pi dependency cohort to 1.2.0 and remove the obsolete Chord override. Runtime Pi modules remain host-provided peers.
- Add SDK regression coverage for user/custom-message startup and model-free context/session commands. Checks run on Node 22.19 and 24.
- Allow only the exact reviewed Pi 1.2.0 versions through the dependency release-age check, preserving the policy for other packages.
