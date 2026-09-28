# the extension breaks the tool calling

> **Archived from pre-migration issue #55.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @staltux on 2026-09-01T14:19:27Z · state CLOSED · labels: released

## Body

using this extensions breaks the pi ability to parse tool calling on gemma 4, and the tokens just bleeds to the chat

                                                                                                 
I will edit the file now:                                                                                                                                     
 <|tool_call>call:edit{edits:[[KZc, jPR, "" ]],path:<|"|>Window.py<|"|>}<tool_call|> 

removing the extension solves the issue

## Comments

### @github-actions — 2026-09-01T15:45:17Z

:tada: This issue has been resolved in version 1.4.3 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v1.4.3)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
