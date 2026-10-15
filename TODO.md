# TODO

- [ ] Confirm the menu bar fix: click the RoutineBar icon through Thaw and check where the menu opens. Then remove the `showMenu frame=` log line in `menubar/RoutineBar.swift` and commit it.
- [ ] Test the missing-result retry with Codex. It reads the session id from Codex's output and has only been tested with Claude.
- [ ] Get the other Mac on the current version. It runs an older copy with no actions and none of the latest fixes. Push this repo to a private GitHub repo, then pull it there.
- [ ] Watch for one duplicate T3 thread. Threads made before the item-matching change were saved under the old item names, so one may get opened again once.
- [ ] Decide on Teams mentions: authorize the Microsoft 365 connector in claude.ai, then add a routine that checks the chat every 10 minutes.
- [ ] Cloud routine times are converted from UTC at today's offset, so they shift an hour when daylight saving changes. Recheck imported times after the switch.
