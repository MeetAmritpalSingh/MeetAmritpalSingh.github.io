const fileInput = document.getElementById("fileInput");
const processBtn = document.getElementById("processBtn");
const statusEl = document.getElementById("status");

let selectedFile = null;

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files[0] || null;
  processBtn.disabled = !selectedFile;

  if (selectedFile) {
    setStatus(`Selected file: ${selectedFile.name}`, "info");
  } else {
    clearStatus();
  }
});

processBtn.addEventListener("click", async () => {
  if (!selectedFile) {
    return;
  }

  try {
    setStatus("Reading workbook...", "info");

    const buffer = await selectedFile.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error("No worksheets found in the uploaded workbook.");
    }

    const firstSheetName = workbook.SheetNames[0];
    const sourceSheet = workbook.Sheets[firstSheetName];

    const raw = XLSX.utils.sheet_to_json(sourceSheet, {
      header: 1,
      blankrows: false,
      defval: ""
    });

    const result = convertToWorkspaceFormat(raw);

    const outputWorkbook = XLSX.utils.book_new();
    const outputSheet = XLSX.utils.aoa_to_sheet(result);

    XLSX.utils.book_append_sheet(outputWorkbook, outputSheet, "Converted");

    const outputName = buildOutputName(selectedFile.name);
    XLSX.writeFile(outputWorkbook, outputName);

    setStatus(`Done. Exported: ${outputName}`, "success");
  } catch (error) {
    console.error(error);
    setStatus(`Error: ${error.message}`, "error");
  }
});

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status";
}

function buildOutputName(inputName) {
  const dotIndex = inputName.lastIndexOf(".");
  const baseName = dotIndex >= 0 ? inputName.slice(0, dotIndex) : inputName;
  return `${baseName}_workspace_format.xlsx`;
}

function clean(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function hasValue(value) {
  return clean(value) !== "";
}

function looksLikeIdentifier(value) {
  const text = clean(value);
  if (!text) {
    return false;
  }
  return /[A-Za-z]/.test(text) && /\d/.test(text);
}

function splitMappingValues(value) {
  const text = clean(value);
  if (!text) {
    return [];
  }
  return text
    .split("|")
    .map(part => part.trim())
    .filter(Boolean);
}

function normalizeRectangular(data) {
  const maxColumns = Math.max(...data.map(row => row.length));

  return data.map(row => {
    const copy = row.slice();
    while (copy.length < maxColumns) {
      copy.push("");
    }
    return copy;
  });
}

function forwardFill2D(data, axis) {
  const output = data.map(row => row.slice());

  if (axis === "row") {
    for (let rowIndex = 0; rowIndex < output.length; rowIndex++) {
      let previous = "";
      for (let colIndex = 0; colIndex < output[rowIndex].length; colIndex++) {
        const current = clean(output[rowIndex][colIndex]);
        if (current === "") {
          output[rowIndex][colIndex] = previous;
        } else {
          output[rowIndex][colIndex] = current;
          previous = current;
        }
      }
    }
  }

  if (axis === "col") {
    if (!output.length) {
      return output;
    }

    const maxColumns = Math.max(...output.map(row => row.length));

    for (let rowIndex = 0; rowIndex < output.length; rowIndex++) {
      while (output[rowIndex].length < maxColumns) {
        output[rowIndex].push("");
      }
    }

    for (let colIndex = 0; colIndex < maxColumns; colIndex++) {
      let previous = "";
      for (let rowIndex = 0; rowIndex < output.length; rowIndex++) {
        const current = clean(output[rowIndex][colIndex]);
        if (current === "") {
          output[rowIndex][colIndex] = previous;
        } else {
          output[rowIndex][colIndex] = current;
          previous = current;
        }
      }
    }
  }

  return output;
}

function blankRepeatedHeaderCellsExceptLast(headerRows) {
  const output = headerRows.map(row => row.slice());
  const lastRowIndex = output.length - 1;

  for (let rowIndex = 0; rowIndex < output.length; rowIndex++) {
    if (rowIndex === lastRowIndex) {
      continue;
    }

    let previous = null;

    for (let colIndex = 0; colIndex < output[rowIndex].length; colIndex++) {
      const current = clean(output[rowIndex][colIndex]);

      if (colIndex === 0) {
        output[rowIndex][colIndex] = current;
        previous = current;
        continue;
      }

      if (current === previous) {
        output[rowIndex][colIndex] = "";
      } else {
        output[rowIndex][colIndex] = current;
        previous = current;
      }
    }
  }

  return output;
}

function convertToWorkspaceFormat(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Input sheet is empty.");
  }

  const normalizedRaw = normalizeRectangular(raw);

  let dataStartRow = null;
  for (let rowIndex = 0; rowIndex < normalizedRaw.length; rowIndex++) {
    if (looksLikeIdentifier(normalizedRaw[rowIndex][0])) {
      dataStartRow = rowIndex;
      break;
    }
  }

  if (dataStartRow === null) {
    throw new Error("Could not detect the first data row.");
  }

  let header = normalizedRaw.slice(0, dataStartRow).map(row => row.slice());
  let body = normalizedRaw.slice(dataStartRow).map(row => row.slice());

  if (header.length === 0) {
    throw new Error("No header rows found above the data.");
  }

  header = forwardFill2D(header, "row");
  header = forwardFill2D(header, "col");

  const columnCount = normalizedRaw[0].length;
  const columnPaths = [];

  for (let colIndex = 0; colIndex < columnCount; colIndex++) {
    const parts = [];
    let previous = null;

    for (let rowIndex = 0; rowIndex < header.length; rowIndex++) {
      const value = clean(header[rowIndex][colIndex]);
      if (!value) {
        continue;
      }
      if (value !== previous) {
        parts.push(value);
      }
      previous = value;
    }

    columnPaths.push(parts);
  }

  const idColumnPath = columnPaths[0];
  const taxonomyColumns = columnPaths.filter((_, index) => index !== 0 && columnPaths[index].length > 0);

  if (taxonomyColumns.length === 0) {
    throw new Error("No taxonomy columns found.");
  }

  body = body
    .filter(row => hasValue(row[0]))
    .map(row => {
      const copy = row.slice();
      copy[0] = clean(copy[0]);
      return copy;
    });

  const mappingValueSet = new Set();

  for (let colIndex = 1; colIndex < columnPaths.length; colIndex++) {
    for (const row of body) {
      const parts = splitMappingValues(row[colIndex]);
      for (const part of parts) {
        mappingValueSet.add(part);
      }
    }
  }

  const mappingValues = Array.from(mappingValueSet).sort((a, b) => a.localeCompare(b));

  if (mappingValues.length === 0) {
    throw new Error("No mapping values found in taxonomy cells.");
  }

  const expandedPaths = [];

  for (let colIndex = 1; colIndex < columnPaths.length; colIndex++) {
    const colPath = columnPaths[colIndex];
    if (!colPath.length) {
      continue;
    }

    for (const mappingValue of mappingValues) {
      expandedPaths.push([...colPath, mappingValue]);
    }
  }

  const maxDepth = Math.max(
    idColumnPath.length,
    ...expandedPaths.map(path => path.length)
  );

  const paddedIdPath = [
    ...idColumnPath,
    ...Array(maxDepth - idColumnPath.length).fill("")
  ];

  const paddedExpandedPaths = expandedPaths.map(path => [
    ...path,
    ...Array(maxDepth - path.length).fill("")
  ]);

  const headerRows = [];

  for (let level = 0; level < maxDepth; level++) {
    const row = [paddedIdPath[level]];
    for (const path of paddedExpandedPaths) {
      row.push(path[level]);
    }
    headerRows.push(row);
  }

  const cleanedHeaderRows = blankRepeatedHeaderCellsExceptLast(headerRows);

  const resultRows = body.map(row => {
    const outputRow = [row[0]];

    for (let colIndex = 1; colIndex < columnPaths.length; colIndex++) {
      const actualValues = new Set(splitMappingValues(row[colIndex]));
      const colPath = columnPaths[colIndex];

      if (!colPath.length) {
        continue;
      }

      for (const mappingValue of mappingValues) {
        outputRow.push(actualValues.has(mappingValue) ? "Y" : "");
      }
    }

    return outputRow;
  });

  return [...cleanedHeaderRows, ...resultRows];
}
