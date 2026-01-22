# Connect-Comp Plugin Documentation

## Overview
Connect-Comp is a Figma plugin that allows you to create "detached" copies of components that maintain a live link to their source. This solves the limitation where you need structural freedom (detaching) but still want style updates from the master component.

## Lifecycle & Data Management

### 1. How Links are Stored
The plugin does **not** maintain a central database or registry of links in the document. Instead, it uses a decentralized approach:
- **PluginData**: Every single layer inside a Linked Copy carries its own metadata (`sourceId`, `rootKey`, `indexPath`) using `node.setPluginData()`.
- **Independence**: Each layer knows where it came from independently. This means you can group, frame, or move parts of a Linked Copy, and they will still sync correctly.

### 2. Deletion Behavior
**Q: What happens when I delete a linked copy?**
A: **It is gone completely.**
Since the data is stored directly on the node (the frame/layer itself), deleting the node deletes the data.
- There are no "orphan links" left behind in the document.
- There is no file bloat from deleted copies.
- If you Undo the deletion, the data returns with the node.

### 3. External Components (Team Libraries)
The plugin stores the `componentKey` (a unique ID that persists across files).
- If the source is local, it uses the Node ID (fast).
- If the source is from a library, it uses the Key to fetch the master component in the background (`importComponentByKeyAsync`), ensuring updates work even if the master isn't in the current file.

## Design Decisions

### Why Recursive Tagging?
**Decision:** We tag every child layer, not just the root frame.
**Reason:** If we only tagged the root, you couldn't wrap a specific button inside a new Auto Layout frame within your detached copy. By tagging the button itself, the plugin can find it and update it regardless of where it moves in your new hierarchy.

### Why Safelisting Properties?
**Decision:** We explicitly choose which properties to sync (Fills, Strokes, Effects) and which to ignore (Characters).
**Reason:** The main use case for detaching is to change content or structure.
- **Text:** We sync font styles (Size, Weight) but **never** the characters. If you change "Button" to "Sign Up", syncing shouldn't revert it to "Button".
- **Overrides:** We allow you to uncheck specific categories (like "Fills") so you can have a different background color while still receiving font updates.

### Granular Auto Layout
**Decision:** Split Auto Layout into Flow, Dimension, Gap, and Padding.
**Reason:**
- **Flow**: You might want to change a horizontal card to a vertical stack.
- **Dimension**: You might want a card to be Fixed width instead of Fill Container.
- **Gap/Padding**: You might need more whitespace than the master.
Splitting these allows "Partial Inheritance"—keeping the style (colors/fonts) strict, but the layout flexible.
