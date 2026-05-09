# Root Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move non-essential files (videos, test images, Graphify-related files) from the root directory to an `extra/` folder to declutter the workspace.

**Architecture:** Simple filesystem reorganization.

**Tech Stack:** PowerShell / Shell commands.

---

### Task 1: Create Extra Directory and Move Files

**Files:**
- Create: `extra/`
- Move: Root files listed below

- [ ] **Step 1: Create the `extra/` directory**

Run: `mkdir extra`

- [ ] **Step 2: Move Graphify-related files**

Run:
```powershell
mv .graphify_ast.json extra/
mv .graphify_detect.json extra/
mv .graphify_python extra/
mv .graphify_uncached.txt extra/
mv graphify-out extra/
```

- [ ] **Step 3: Move test images**

Run:
```powershell
mv test_fast.webp extra/
mv test.webp extra/
```

- [ ] **Step 4: Move video files**

Run:
```powershell
mv output_180.mov extra/
mv output_360.mov extra/
mv output_700.mov extra/
mv output_default.mov extra/
mv output_prores.mov extra/
mv test_out1.mp4 extra/
mv test_out2.mp4 extra/
mv test_video.mp4 extra/
```

- [ ] **Step 5: Verify relocation**

Run: `ls extra`
Expected: All moved files should be present in `extra/`.

- [ ] **Step 6: Commit changes**

```bash
git add extra/ .graphify_ast.json .graphify_detect.json .graphify_python .graphify_uncached.txt graphify-out test_fast.webp test.webp output_180.mov output_360.mov output_700.mov output_default.mov output_prores.mov test_out1.mp4 test_out2.mp4 test_video.mp4
git commit -m "chore: move extra files and graphify data to extra folder"
```
