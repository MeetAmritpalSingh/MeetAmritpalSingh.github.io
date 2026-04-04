const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');
const statusEl = document.getElementById('status');

let selectedFile = null;

fileInput.addEventListener('change', () => {
  selectedFile = fileInput.files[0] || null;
  processBtn.disabled = !selectedFile;
  setStatus(selectedFile ? `Selected file: ${selectedFile.name}` : '', 'info');
});

processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  try {
    setStatus('Reading workbook...', 'info');
    const arrayBuffer = await selectedFile.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });

    if (!workbook.SheetNames.length) {
      throw new Error('No worksheets found in the uploaded workbook.');
    }

    const firstSheetName = workbook.SheetNames[0];
    const sourceSheet = workbook.Sheets[firstSheetName];
    const raw = XLSX.utils.sheet_to_json(sourceSheet, {
      header: 1,
      blankrows: false,
      defval: ''
    });

    const result = convertToWorkspaceFormat(raw);

    const outWb = XLSX.utils.book_new();
    const outWs = XLSX.utils.aoa_to_sheet(result);
    XLSX.utils.book_append_sheet(outWb, outWs, 'Converted');

    const outputName = buildOutputName(selectedFile.name);
    XLSX.writeFile(outWb, outputName);
    setStatus(`Done. Exported: ${outputName}`, 'success');
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, 'error');
  }
});

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
}

function buildOutputName(inputName) {
  const dot = inputName.lastIndexOf('.');
  const base = dot >= 0 ? inputName.slice(0, dot) : inputName;
  return `${base}_workspace_format.xlsx`;
}

function clean(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function hasValue(val) {
  return clean(val) !== '';
}

function looksLikeIdentifier(val) {
  const s = clean(val);
  if (!s) return false;
  return /[A-Za-z]/.test(s) && /\d/.test(s);
}

function splitMappingValues(val) {
  const s = clean(val);
  if (!s) return [];
  return s.split('|').map(part => part.trim()).filter(Boolean);
}

function forwardFill2D(data, axis) {
  const out = data.map(row => row.slice());

  if (axis === 'row') {
    for (let r = 0; r < out.length; r++) {
      let prev = '';
      for (let c = 0; c < out[r].length; c++) {
        const current = clean(out[r][c]);
        if (current === '') {
          out[r][c] = prev;
        } else {
          prev = current;
          out[r][c] = current;
        }
      }
    }
  }

  if (axis === 'col') {
    if (!out.length) return out;
    const cols = Math.max(...out.map(r => r.length));

    for (let r = 0; r < out.length; r++) {
      while (out[r].length < cols) out[r].push('');
    }

    for (let c = 0; c < cols; c++) {
      let prev = '';
      for (let r = 0; r < out.length; r++) {
        const current = clean(out[r][c]);
        if (current === '') {
          out[r][c] = prev;
        } else {
          prev = current;
          out[r][c] = current;
        }
      }
    }
  }

  return out;
}

function blankRepeatedHeaderCellsExceptLast(df) {
  const out = df.map(row => row.slice());
  const lastRow = out.length - 1;

  for (let r = 0; r < out.length; r++) {
    if (r === lastRow) continue;

    let prev = null;
    for (let c = 0; c < out[r].length; c++) {
      const val = clean(out[r][c]);
      if (c === 0) {
        prev = val;
        out[r][c] = val;
        continue;
      }
      if (val === prev) {
        out[r][c] = '';
      } else {
        prev = val;
        out[r][c] = val;
      }
    }
  }

  return out;
}

function normalizeRectangular(data) {
  const cols = Math.max(...data.map(r => r.length));
  return data.map(row => {
    const copy = row.slice();
    while (copy.length < cols) copy.push('');
    return copy;
  });
}

function convertToWorkspaceFormat(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error('Input sheet is empty.');
  }

  raw = normalizeRectangular(raw);

  let dataStartRow = null;
  for (let i = 0; i < raw.length; i++) {
    if (looksLikeIdentifier(raw[i][0])) {
      dataStartRow = i;
      break;
    }
  }

  if (dataStartRow === null) {
    throw new Error('Could not detect the first data row.');
  }

  let header = raw.slice(0, dataStartRow).map(r => r.slice());
  let body = raw.slice(dataStartRow).map(r => r.slice());

  if (!header.length) {
    throw new Error('No header rows found above the data.');
  }

  header = forwardFill2D(header, 'row');
  header = forwardFill2D(header, 'col');

  const columnPaths = [];
  const colCount = raw[0].length;

  for (let colIdx = 0; colIdx < colCount; colIdx++) {
    const parts = [];
    let prev = null;

    for (let rowIdx = 0; rowIdx < header.length; rowIdx++) {
      const v = clean(header[rowIdx][colIdx]);
      if (!v) continue;
      if (v !== prev) parts.push(v);
      prev = v;
    }

    columnPaths.push(parts);
  }

  const idCol = columnPaths[0];
  const taxonomyCols = columnPaths.filter((_, i) => i !== 0 && columnPaths[i].length > 0);

  if (!taxonomyCols.length) {
    throw new Error('No taxonomy columns found.');
  }

  body = body
    .filter(row => hasValue(row[0]))
    .map(row => {
      const copy = row.slice();
      copy[0] = clean(copy[0]);
      return copy;
    });

  const mappingSet = new Set();
  for (let colIndex = 1; colIndex < columnPaths.length; colIndex++) {
    for (const row of body) {
      for (const part of splitMappingValues(row[colIndex])) {
        mappingSet.add(part);
      }
    }
  }

  const mappingValues = Array.from(mappingSet).sort((a, b) => a.localeCompare(b));

  if (!mappingValues.length) {
    throw new Error('No mapping values found in taxonomy cells.');
  }

  const expandedPaths = [];
  for (let colIndex = 1; colIndex < columnPaths.length; colIndex++) {
    const colPath = columnPaths[colIndex];
    if (!colPath.length) continue;

    for (const mappingValue of mappingValues) {
      expandedPaths.push([...colPath, mappingValue]);
    }
  }

  const maxDepth = Math.max(idCol.length, ...expandedPaths.map(p => p.length));

  const paddedIdPath = [...idCol, ...Array(maxDepth - idCol.length).fill('')];
  const paddedExpandedPaths = expandedPaths.map(p => [
    ...p,
    ...Array(maxDepth - p.length).fill('')
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
    const outRow = [row[0]];

    for (let colIndex = 1; colIndex < columnPaths.length; colIndex++) {
      const actualValues = new Set(splitMappingValues(row[colIndex]));
      const colPath = columnPaths[colIndex];
      if (!colPath.length) continue;

      for (const mappingValue of mappingValues) {
        outRow.push(actualValues.has(mappingValue) ? 'Y' : '');
      }
    }

    return outRow;
  });

  return [...cleanedHeaderRows, ...resultRows];
}
