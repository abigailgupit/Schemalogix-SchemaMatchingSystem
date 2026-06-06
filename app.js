const state = {
  threshold: 0.7,
  source: null,
  target: null,
  truth: [],
  candidates: [],
  predictions: [],
  model: null,
  feedback: new Map(),
  logs: []
};

const abbreviations = new Map([
  ["id", "identifier"],
  ["no", "number"],
  ["num", "number"],
  ["stud", "student"],
  ["emp", "employee"],
  ["dept", "department"],
  ["yr", "year"],
  ["lvl", "level"],
  ["dob", "birth date"],
  ["dt", "date"],
  ["gwa", "average grade"],
  ["php", "salary"],
  ["fname", "first name"],
  ["lname", "last name"]
]);

function parseCsv(csv) {
  const rows = csv.trim().split(/\r?\n/).map((line) => {
    const result = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        result.push(cell.trim());
        cell = "";
      } else {
        cell += char;
      }
    }
    result.push(cell.trim());
    return result;
  });

  const headers = rows[0] || [];
  const data = rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  });
  return { headers, rows: data };
}

function addLog(message) {
  const time = new Date().toLocaleString();
  state.logs.unshift({ time, message });
  renderLogs();
}

function inferType(values) {
  const present = values.filter((value) => String(value).trim() !== "");
  if (!present.length) return "empty";
  const numeric = present.filter((value) => !Number.isNaN(Number(value))).length / present.length;
  const date = present.filter((value) => !Number.isNaN(Date.parse(value)) && /[-/]/.test(value)).length / present.length;
  if (date >= 0.75) return "date";
  if (numeric >= 0.75) return "numeric";
  const uniqueRatio = new Set(present.map((value) => value.toLowerCase())).size / present.length;
  return uniqueRatio <= 0.65 ? "categorical" : "text";
}

function columnProfile(dataset, header, index) {
  const values = dataset.rows.map((row) => row[header] ?? "");
  return {
    name: header,
    index,
    type: inferType(values),
    values
  };
}

function normalizeName(name) {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

function tokens(name) {
  return normalizeName(name)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => {
      const expanded = abbreviations.get(token);
      return expanded ? expanded.split(" ") : [token];
    });
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function nameSimilarity(a, b) {
  const aTokens = tokens(a);
  const bTokens = tokens(b);
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  const union = new Set([...setA, ...setB]).size || 1;
  const overlap = [...setA].filter((token) => setB.has(token)).length / union;
  const joinedA = aTokens.join(" ");
  const joinedB = bTokens.join(" ");
  const distance = levenshtein(joinedA, joinedB);
  const maxLength = Math.max(joinedA.length, joinedB.length, 1);
  const editScore = 1 - distance / maxLength;
  return clamp((overlap * 0.65) + (editScore * 0.35));
}

function typeSimilarity(a, b) {
  if (a.type === b.type) return 1;
  const compatible = new Set(["numeric:date", "text:categorical", "categorical:text"]);
  return compatible.has(`${a.type}:${b.type}`) || compatible.has(`${b.type}:${a.type}`) ? 0.55 : 0.15;
}

function structuralSimilarity(a, b, sourceCount, targetCount) {
  const sourcePosition = sourceCount === 1 ? 0 : a.index / (sourceCount - 1);
  const targetPosition = targetCount === 1 ? 0 : b.index / (targetCount - 1);
  return clamp(1 - Math.abs(sourcePosition - targetPosition));
}

function distributionSimilarity(a, b) {
  if (a.type === "numeric" && b.type === "numeric") {
    const statsA = numericStats(a.values);
    const statsB = numericStats(b.values);
    const meanScore = ratioScore(statsA.mean, statsB.mean);
    const spreadScore = ratioScore(statsA.std, statsB.std);
    return clamp((meanScore + spreadScore) / 2);
  }
  if (a.type === "date" && b.type === "date") {
    return ratioScore(new Set(a.values).size, new Set(b.values).size);
  }
  const valuesA = new Set(a.values.map((value) => String(value).toLowerCase()));
  const valuesB = new Set(b.values.map((value) => String(value).toLowerCase()));
  const overlap = [...valuesA].filter((value) => valuesB.has(value)).length;
  const union = new Set([...valuesA, ...valuesB]).size || 1;
  const valueOverlap = overlap / union;
  const lengthScore = ratioScore(averageLength(a.values), averageLength(b.values));
  return clamp((valueOverlap * 0.7) + (lengthScore * 0.3));
}

function numericStats(values) {
  const nums = values.map(Number).filter((value) => !Number.isNaN(value));
  const mean = nums.reduce((sum, value) => sum + value, 0) / Math.max(nums.length, 1);
  const variance = nums.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(nums.length, 1);
  return { mean, std: Math.sqrt(variance) };
}

function averageLength(values) {
  const lengths = values.map((value) => String(value).length);
  return lengths.reduce((sum, length) => sum + length, 0) / Math.max(lengths.length, 1);
}

function ratioScore(a, b) {
  const max = Math.max(Math.abs(a), Math.abs(b), 1);
  return clamp(1 - Math.abs(a - b) / max);
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function schemaDescription(profile) {
  const sampleValues = profile.values
    .filter((value) => String(value).trim() !== "")
    .slice(0, 8)
    .join(" ");
  return `${profile.name} ${tokens(profile.name).join(" ")} ${profile.type} ${sampleValues}`;
}

function documentTokens(text) {
  return normalizeName(text)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => {
      const expanded = abbreviations.get(token);
      return expanded ? expanded.split(" ") : [token];
    });
}

function buildTfIdf(profiles) {
  const documents = profiles.map(schemaDescription).map(documentTokens);
  const vocabulary = [...new Set(documents.flat())];
  const idf = new Map();
  vocabulary.forEach((term) => {
    const docsWithTerm = documents.filter((doc) => doc.includes(term)).length;
    idf.set(term, Math.log((1 + documents.length) / (1 + docsWithTerm)) + 1);
  });

  return profiles.map((profile, index) => ({
    profile,
    vector: vocabulary.map((term) => {
      const count = documents[index].filter((token) => token === term).length;
      return count * idf.get(term);
    })
  }));
}

function cosineSimilarity(vectorA, vectorB) {
  const dot = vectorA.reduce((sum, value, index) => sum + (value * vectorB[index]), 0);
  const normA = Math.sqrt(vectorA.reduce((sum, value) => sum + (value ** 2), 0));
  const normB = Math.sqrt(vectorB.reduce((sum, value) => sum + (value ** 2), 0));
  if (!normA || !normB) return 0;
  return clamp(dot / (normA * normB));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function logisticScore(weights, features) {
  const z = weights.reduce((sum, weight, index) => sum + (weight * features[index]), 0);
  return sigmoid(z);
}

function bootstrapLabel(candidate) {
  if (candidate.cosine >= 0.72 || (candidate.name >= 0.72 && candidate.type >= 0.55)) return 1;
  if ((candidate.cosine <= 0.25 && candidate.name <= 0.35) || candidate.type <= 0.15) return 0;
  return null;
}

function trainLogisticRegression(candidates) {
  const training = [];
  candidates.forEach((candidate) => {
    const feedback = state.feedback.get(candidate.id);
    const label = typeof feedback === "number" ? feedback : bootstrapLabel(candidate);
    if (label !== null) {
      training.push({ features: candidate.features, label });
    }
  });

  let weights = [0, 1.1, 1.0, 0.75, 0.45, 0.35];
  if (training.length >= 2 && new Set(training.map((item) => item.label)).size > 1) {
    weights = [0, 0, 0, 0, 0, 0];
    const learningRate = 0.45;
    for (let epoch = 0; epoch < 650; epoch += 1) {
      training.forEach((item) => {
        const prediction = logisticScore(weights, item.features);
        const error = prediction - item.label;
        weights = weights.map((weight, index) => weight - (learningRate * error * item.features[index]));
      });
    }
  }

  return {
    weights,
    trainingCount: training.length,
    positiveCount: training.filter((item) => item.label === 1).length,
    negativeCount: training.filter((item) => item.label === 0).length
  };
}

function scoreDatasets() {
  if (!state.source || !state.target) {
    addLog("Matching skipped. Upload both Dataset A and Dataset B first.");
    renderAll();
    return;
  }

  const sourceProfiles = state.source.headers.map((header, index) => columnProfile(state.source, header, index));
  const targetProfiles = state.target.headers.map((header, index) => columnProfile(state.target, header, index));
  const tfidf = buildTfIdf([...sourceProfiles, ...targetProfiles]);
  const sourceVectors = tfidf.slice(0, sourceProfiles.length);
  const targetVectors = tfidf.slice(sourceProfiles.length);
  const candidates = [];

  sourceVectors.forEach((sourceVector) => {
    targetVectors.forEach((targetVector) => {
      const sourceProfile = sourceVector.profile;
      const targetProfile = targetVector.profile;
      const cosine = cosineSimilarity(sourceVector.vector, targetVector.vector);
      const name = nameSimilarity(sourceProfile.name, targetProfile.name);
      const type = typeSimilarity(sourceProfile, targetProfile);
      const structure = structuralSimilarity(sourceProfile, targetProfile, sourceProfiles.length, targetProfiles.length);
      const distribution = distributionSimilarity(sourceProfile, targetProfile);
      const features = [1, cosine, name, type, structure, distribution];
      const id = pairKey(sourceProfile.name, targetProfile.name);
      candidates.push({
        id,
        source: sourceProfile.name,
        target: targetProfile.name,
        sourceType: sourceProfile.type,
        targetType: targetProfile.type,
        cosine,
        name,
        type,
        structure,
        distribution,
        features,
        bootstrap: bootstrapLabel({ cosine, name, type })
      });
    });
  });

  state.model = trainLogisticRegression(candidates);
  state.candidates = candidates.map((candidate) => ({
    ...candidate,
    finalScore: logisticScore(state.model.weights, candidate.features)
  })).sort((a, b) => b.finalScore - a.finalScore);
  state.predictions = pickPredictions(state.candidates);
  addLog(`SchemaLogix matching completed with ${state.candidates.length} candidates and ${state.model.trainingCount} bootstrapped training labels.`);
  renderAll();
}

function pickPredictions(candidates) {
  if (!state.source || !candidates.length) return [];
  return state.source.headers.map((source) => {
    const best = candidates
      .filter((candidate) => candidate.source === source)
      .sort((a, b) => b.finalScore - a.finalScore)[0];
    return {
      ...best,
      decision: best.finalScore >= state.threshold ? "Match" : "Non-match"
    };
  });
}

function pairKey(source, target) {
  return `${source}=>${target}`;
}

function metrics() {
  const matches = state.predictions.filter((prediction) => prediction.decision === "Match");
  const averageProbability = matches.length
    ? matches.reduce((sum, prediction) => sum + prediction.finalScore, 0) / matches.length
    : 0;
  return {
    averageProbability,
    validated: state.feedback.size
  };
}

function renderAll() {
  renderColumns();
  renderRecommendations();
  renderPreviews();
  renderResults();
  renderMatchMatrix();
  renderMergedSchema();
  renderMetrics();
}

function renderColumns() {
  const sourceColumns = state.source ? state.source.headers.map((header, index) => columnProfile(state.source, header, index)) : [];
  const targetColumns = state.target ? state.target.headers.map((header, index) => columnProfile(state.target, header, index)) : [];
  document.getElementById("sourceColumnCount").textContent = `${sourceColumns.length} fields`;
  document.getElementById("targetColumnCount").textContent = `${targetColumns.length} fields`;
  document.getElementById("sourceColumns").innerHTML = sourceColumns.length
    ? sourceColumns.map(columnMarkup).join("")
    : emptyState("Upload Dataset A to view columns.");
  document.getElementById("targetColumns").innerHTML = targetColumns.length
    ? targetColumns.map(columnMarkup).join("")
    : emptyState("Upload Dataset B to view columns.");
}

function columnMarkup(column) {
  return `<div class="column-item"><code>${escapeHtml(column.name)}</code><span class="type-badge">${column.type}</span></div>`;
}

function renderRecommendations() {
  const matches = state.predictions.filter((prediction) => prediction.decision === "Match");
  document.getElementById("recommendedMatches").innerHTML = matches.length
    ? matches.map((prediction) => `
      <article class="match-item">
        <div>
          <div class="match-title">
            <code>${escapeHtml(prediction.source)}</code>
            <span>to</span>
            <code>${escapeHtml(prediction.target)}</code>
          </div>
          <div class="score-bar" aria-hidden="true"><span style="width:${Math.round(prediction.finalScore * 100)}%"></span></div>
        </div>
        <span class="decision-badge match">P=${formatScore(prediction.finalScore)}</span>
      </article>
    `).join("")
    : `<div class="match-item"><strong>No matches above threshold.</strong></div>`;
  document.getElementById("thresholdBadge").textContent = `Threshold ${state.threshold.toFixed(2)}`;
}

function renderPreviews() {
  if (!state.source) {
    document.getElementById("sourceRows").textContent = "0 rows";
    document.getElementById("sourcePreview").innerHTML = emptyTable("No Dataset A uploaded.");
  } else {
    document.getElementById("sourceRows").textContent = `${state.source.rows.length} rows`;
    document.getElementById("sourcePreview").innerHTML = previewTable(state.source);
  }

  if (!state.target) {
    document.getElementById("targetRows").textContent = "0 rows";
    document.getElementById("targetPreview").innerHTML = emptyTable("No Dataset B uploaded.");
  } else {
    document.getElementById("targetRows").textContent = `${state.target.rows.length} rows`;
    document.getElementById("targetPreview").innerHTML = previewTable(state.target);
  }
}

function emptyTable(message) {
  return `<tbody><tr><td>${escapeHtml(message)}</td></tr></tbody>`;
}

function emptyState(message) {
  return `<div class="column-item"><span>${escapeHtml(message)}</span></div>`;
}

function previewTable(dataset) {
  const headers = dataset.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rows = dataset.rows.slice(0, 4).map((row) => {
    const cells = dataset.headers.map((header) => `<td>${escapeHtml(row[header])}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<thead><tr>${headers}</tr></thead><tbody>${rows}</tbody>`;
}

function renderResults() {
  if (!state.candidates.length) {
    document.getElementById("candidateCount").textContent = "0 pairs";
    document.getElementById("resultsTable").innerHTML = emptyTable("No candidate pairs yet. Upload two CSV files and run matching.");
    return;
  }

  document.getElementById("candidateCount").textContent = `${state.candidates.length} pairs`;
  const rows = state.candidates.map((candidate) => {
    const decision = candidate.finalScore >= state.threshold ? "Match" : "Non-match";
    const badgeClass = decision === "Match" ? "match" : "nomatch";
    const feedback = state.feedback.get(candidate.id);
    const feedbackLabel = feedback === 1 ? "Approved" : feedback === 0 ? "Rejected" : "Unvalidated";
    return `<tr>
      <td>${escapeHtml(candidate.source)}</td>
      <td>${escapeHtml(candidate.target)}</td>
      <td>${formatScore(candidate.cosine)}</td>
      <td>${formatScore(candidate.name)}</td>
      <td>${formatScore(candidate.type)}</td>
      <td>${formatScore(candidate.structure)}</td>
      <td><strong>${formatScore(candidate.finalScore)}</strong></td>
      <td><span class="decision-badge ${badgeClass}">${decision}</span></td>
      <td>
        <div class="validation-actions">
          <span>${feedbackLabel}</span>
          <button type="button" onclick="validateCandidateByEncoded('${encodeURIComponent(candidate.id)}', 1)">Approve</button>
          <button type="button" onclick="validateCandidateByEncoded('${encodeURIComponent(candidate.id)}', 0)">Reject</button>
        </div>
      </td>
    </tr>`;
  }).join("");
  document.getElementById("resultsTable").innerHTML = `
    <thead>
      <tr>
        <th>Dataset A Field</th>
        <th>Dataset B Field</th>
        <th>TF-IDF Cosine</th>
        <th>Name</th>
        <th>Type</th>
        <th>Structure</th>
        <th>LR Probability</th>
        <th>Decision</th>
        <th>User Validation</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>`;
}

function renderMatchMatrix() {
  document.getElementById("matrixCount").textContent = `Threshold ${state.threshold.toFixed(2)}`;
  if (!state.source || !state.target || !state.candidates.length) {
    document.getElementById("matchMatrix").innerHTML = emptyTable("No match matrix yet.");
    return;
  }

  const lookup = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
  const headerCells = state.target.headers.map((target) => `<th>${escapeHtml(target)}</th>`).join("");
  const rows = state.source.headers.map((source) => {
    const cells = state.target.headers.map((target) => {
      const candidate = lookup.get(pairKey(source, target));
      const isMatch = candidate && candidate.finalScore >= state.threshold;
      return `<td><span class="matrix-cell ${isMatch ? "matrix-match" : "matrix-no"}">${isMatch ? "1" : "0"}</span></td>`;
    }).join("");
    return `<tr><th>${escapeHtml(source)}</th>${cells}</tr>`;
  }).join("");

  document.getElementById("matchMatrix").innerHTML = `
    <thead><tr><th>Dataset A \\ Dataset B</th>${headerCells}</tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderMergedSchema() {
  const matched = state.predictions.filter((prediction) => prediction.decision === "Match");
  document.getElementById("mergedCount").textContent = `${matched.length} fields`;
  document.getElementById("mergedSchema").innerHTML = matched.length ? matched.map((prediction) => `
    <div class="schema-item">
      <code>${escapeHtml(prediction.source)}</code> merged with <code>${escapeHtml(prediction.target)}</code>
    </div>
  `).join("") : `<div class="schema-item">No merged schema yet.</div>`;
}

function renderMetrics() {
  const { averageProbability, validated } = metrics();
  const matches = state.predictions.filter((prediction) => prediction.decision === "Match").length;
  const unmatched = state.predictions.filter((prediction) => prediction.decision !== "Match").length;
  document.getElementById("matchCount").textContent = matches;
  document.getElementById("unmatchedSourceCount").textContent = unmatched;
  document.getElementById("precisionValue").textContent = averageProbability.toFixed(2);
  document.getElementById("f1Value").textContent = validated;
}

function renderLogs() {
  document.getElementById("logList").innerHTML = state.logs.map((log) => `
    <div class="log-item"><strong>${escapeHtml(log.time)}</strong><span>${escapeHtml(log.message)}</span></div>
  `).join("");
}

function formatScore(score) {
  return score.toFixed(2);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setupTabs() {
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((tab) => tab.classList.remove("active"));
      document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
      button.classList.add("active");
      document.getElementById(button.dataset.view).classList.add("active");
    });
  });
}

function setupEvents() {
  document.getElementById("runButton").addEventListener("click", scoreDatasets);
  document.getElementById("thresholdInput").addEventListener("input", (event) => {
    state.threshold = Number(event.target.value);
    document.getElementById("thresholdOutput").textContent = state.threshold.toFixed(2);
    state.predictions = pickPredictions(state.candidates);
    addLog(`Threshold changed to ${state.threshold.toFixed(2)}.`);
    renderAll();
  });
  document.getElementById("sourceUpload").addEventListener("change", (event) => loadUploadedCsv(event, "source"));
  document.getElementById("targetUpload").addEventListener("change", (event) => loadUploadedCsv(event, "target"));
}

function loadUploadedCsv(event, side) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state[side] = parseCsv(reader.result);
    state.truth = [];
    state.candidates = [];
    state.predictions = [];
    state.feedback.clear();
    state.model = null;
    if (side === "source") {
      document.getElementById("sourceName").textContent = `Dataset A: ${file.name}`;
    } else {
      document.getElementById("targetName").textContent = `Dataset B: ${file.name}`;
    }
    addLog(`Loaded uploaded ${side === "source" ? "Dataset A" : "Dataset B"} file: ${file.name}.`);
    if (state.source && state.target) {
      scoreDatasets();
    } else {
      renderAll();
    }
  };
  reader.readAsText(file);
}

function validateCandidate(id, label) {
  state.feedback.set(id, label);
  const text = label === 1 ? "approved as a valid match" : "rejected as a non-match";
  addLog(`User validation recorded: ${id} ${text}.`);
  if (state.source && state.target) {
    scoreDatasets();
  } else {
    renderAll();
  }
}

window.validateCandidate = validateCandidate;
window.validateCandidateByEncoded = (encodedId, label) => validateCandidate(decodeURIComponent(encodedId), label);

setupTabs();
setupEvents();
addLog("Prototype ready. Upload Dataset A and Dataset B to begin.");
renderAll();
