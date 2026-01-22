figma.showUI(__html__, { width: 240, height: 400 });

// Selection listener
figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;
  let hasLink = false;
  
  if (selection.length > 0) {
    // Check if the selected node (or first one) has a link
    if (selection[0].getPluginData("sourceId")) {
      hasLink = true;
    }
  }
  
  figma.ui.postMessage({ type: 'selection-changed', hasLink });
});

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'resize') {
    figma.ui.resize(msg.width, msg.height);
  } else if (msg.type === 'create-linked') {
    await createLinked();
  } else if (msg.type === 'sync') {
    await syncSelection(msg.options);
  } else if (msg.type === 'go-to-source') {
    goToSource();
  }
};

function goToSource() {
  const node = figma.currentPage.selection[0];
  if (!node) return;

  const sourceId = node.getPluginData("sourceId");
  if (sourceId) {
    const source = figma.getNodeById(sourceId);
    if (source) {
      // Find the page the source node belongs to
      let page = source.parent;
      while (page && page.type !== "PAGE") {
        page = page.parent;
      }

      // If source is on a different page, switch to it
      if (page && page !== figma.currentPage) {
        figma.currentPage = page;
      }

      figma.currentPage.selection = [source];
      figma.viewport.scrollAndZoomIntoView([source]);
      figma.notify("Moved to Source Component");
    } else {
      figma.notify("Source component is not in this file (or was deleted).");
    }
  }
}

// --- Create Linked ---

async function createLinked() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.notify("Select a Component, Instance, or Component Set");
    return;
  }

  let createdCount = 0;

  for (const node of selection) {
    let sourceNode = node;
    let instance;

    try {
      // Handle different types to get a valid instance
      if (node.type === "COMPONENT_SET") {
        sourceNode = node.defaultVariant;
        instance = sourceNode.createInstance();
      } else if (node.type === "COMPONENT") {
        instance = node.createInstance();
      } else if (node.type === "INSTANCE") {
        // For instances, we clone them to preserve overrides in the link source
        instance = node.clone();
      } else {
        continue;
      }

      // 1. Create instance -> Detach
      const detached = instance.detachInstance();

      // Position nearby (e.g., to the right)
      detached.x = node.x + node.width + 50;
      detached.y = node.y;
      detached.name = "Linked: " + sourceNode.name;
      
      // Ensure it's selected or at least evident
      figma.currentPage.selection = [detached];

      // 2. Determine Root Key (for fallback)
      let rootKey = null;
      // Only store key if the root source is a Component (or Set variant)
      if (sourceNode.type === "COMPONENT") {
        rootKey = sourceNode.key;
      }

      // 3. Recursive Walk & Set Plugin Data
      walkAndLink(sourceNode, detached, "root", rootKey);

      createdCount++;
    } catch (err) {
      console.error("Failed to create link for node", node.name, err);
    }
  }

  figma.notify(`Created ${createdCount} linked element(s)`);
}

function walkAndLink(source, target, indexPath, rootKey) {
  // Set metadata
  target.setPluginData("sourceId", source.id);
  target.setPluginData("indexPath", indexPath);
  
  if (rootKey) {
    target.setPluginData("rootKey", rootKey);
  }

  // Recurse children
  // Since 'target' is a detached instance of 'source', structures should align.
  if ("children" in source && "children" in target) {
    const sChildren = source.children;
    const tChildren = target.children;

    for (let i = 0; i < sChildren.length; i++) {
      // Safety check if children align
      if (tChildren[i]) {
        walkAndLink(sChildren[i], tChildren[i], `${indexPath}-${i}`, rootKey);
      }
    }
  }
}

// --- Sync ---

async function syncSelection(options) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.notify("Select linked elements to sync");
    return;
  }

  // Set default options if undefined (e.g. older UI)
  const syncOptions = options || {
    fills: true, strokes: true, effects: true, 
    text: true, corners: true, 
    flow: true, dimension: true, gap: true, padding: true,
    name: true
  };

  // Gather all syncable nodes recursively from selection
  const nodesToSync = [];
  function collectNodes(node) {
    if (node.getPluginData("sourceId")) {
      nodesToSync.push(node);
    }
    if ("children" in node) {
      for (const child of node.children) {
        collectNodes(child);
      }
    }
  }

  for (const node of selection) {
    collectNodes(node);
  }

  if (nodesToSync.length === 0) {
    figma.notify("No linked nodes found in selection");
    return;
  }

  let successCount = 0;
  let failureCount = 0;

  for (const target of nodesToSync) {
    try {
      const result = await syncNode(target, syncOptions);
      if (result) successCount++;
      else failureCount++;
    } catch (err) {
      console.error("Sync error:", err);
      failureCount++;
    }
  }

  figma.notify(`Sync complete: ${successCount} updated, ${failureCount} failed`);
}

async function syncNode(target, options) {
  const sourceId = target.getPluginData("sourceId");
  if (!sourceId) return false;

  // 1. Try getNodeById
  let source = figma.getNodeById(sourceId);

  // 2. Fallback: rootKey + indexPath
  if (!source) {
    const rootKey = target.getPluginData("rootKey");
    const indexPath = target.getPluginData("indexPath");

    if (rootKey && indexPath) {
      try {
        const importedComponent = await figma.importComponentByKeyAsync(rootKey);
        source = findNodeByIndex(importedComponent, indexPath);
      } catch (e) {
        // Fallback failed (component deleted or inaccessible)
      }
    }
  }

  if (!source) return false;

  // 3. Apply Styles
  await applyStyles(source, target, options);
  return true;
}

function findNodeByIndex(root, indexPath) {
  if (indexPath === "root") return root;
  
  const parts = indexPath.split("-"); // ["root", "0", "1"]
  let current = root;
  
  // Skip first part ("root")
  for (let i = 1; i < parts.length; i++) {
    const index = parseInt(parts[i], 10);
    if (current && "children" in current && current.children[index]) {
      current = current.children[index];
    } else {
      return null;
    }
  }
  return current;
}

async function applyStyles(source, target, options) {
  // Helper to safely copy properties
  const safeCopy = (prop) => {
    try {
      // Handle Mixed: If source is mixed, we can't easily sync it to a single target property
      if (source[prop] === figma.mixed) return;
      
      // If target doesn't support property, skip
      if (target[prop] === undefined) return;
      
      target[prop] = source[prop];
    } catch (e) {
      // Catch readonly errors or type mismatches
    }
  };

  // 1. Common Visual Props
  if (options.name) {
    try { target.name = source.name; } catch(e) {}
  }

  if (options.fills) {
    ["fills", "opacity", "blendMode", "visible"].forEach(safeCopy);
  }

  if (options.strokes) {
    const strokeProps = [
      "strokes", "strokeWeight", "strokeAlign", 
      "strokeCap", "strokeJoin", "dashPattern", "strokeMiterLimit",
      // Individual strokes support
      "strokeTopWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeRightWeight"
    ];
    strokeProps.forEach(safeCopy);
  }

  if (options.effects) {
    ["effects"].forEach(safeCopy);
  }

  // 2. Corner Radius (Individual + Smoothing)
  if (options.corners) {
    const cornerProps = [
      "cornerRadius", "cornerSmoothing",
      "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"
    ];
    cornerProps.forEach(safeCopy);
  }

  // 3. Text Styles (if both are Text)
  if (options.text && source.type === "TEXT" && target.type === "TEXT") {
    // Must load font before setting it
    if (source.fontName !== figma.mixed) {
      try {
        await figma.loadFontAsync(source.fontName);
        target.fontName = source.fontName;
      } catch (e) { console.error("Font load failed", e); }
    }

    const textProps = [
      "fontSize", "letterSpacing", "lineHeight",
      "paragraphIndent", "paragraphSpacing", "textCase", 
      "textDecoration", "textAlignHorizontal", "textAlignVertical"
    ];
    textProps.forEach(safeCopy);
  }

  // 4. Auto Layout Parts
  // Flow: Direction & Alignment
  if (options.flow) {
    [
      "layoutMode", "primaryAxisAlignItems", "counterAxisAlignItems", 
      "itemReverseZIndex", "strokesIncludedInLayout", "layoutWrap"
    ].forEach(safeCopy);
  }

  // Dimension: Sizing Modes (Fixed, Hug, Fill)
  if (options.dimension) {
    [
      "primaryAxisSizingMode", "counterAxisSizingMode", 
      "layoutSizingHorizontal", "layoutSizingVertical"
    ].forEach(safeCopy);
  }

  // Gap: Item Spacing
  if (options.gap) {
    ["itemSpacing", "counterAxisSpacing"].forEach(safeCopy);
  }

  // Padding
  if (options.padding) {
    ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"].forEach(safeCopy);
  }
}