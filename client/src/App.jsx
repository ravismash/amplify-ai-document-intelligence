import { useEffect, useRef, useState } from 'react';

const API_BASE = 'http://localhost:4000';
const API_KEY = import.meta.env.VITE_API_KEY || '';

function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...(API_KEY ? { 'x-api-key': API_KEY } : {}) }
  });
}

const supportedFormats = [
  { format: 'PDF', limit: '25 MB' },
  { format: 'Microsoft Word', limit: '25 MB' },
  { format: 'Microsoft Excel', limit: '25 MB' },
  { format: 'PNG / JPEG scans', limit: '25 MB' },
  { format: 'Plain text', limit: '10 MB' },
  { format: 'CSV', limit: '10 MB' }
];

const workflowSteps = [
  'Upload and validate documents',
  'Extract and normalize text',
  'Index traceable document chunks',
  'Ask questions with citations',
  'Generate a downloadable report'
];

const processingStages = ['Uploaded', 'Extracting', 'Extracted', 'Indexing', 'Ready'];

const supportedFileTypes = {
  'application/pdf': 25,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 25,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 25,
  'image/png': 25,
  'image/jpeg': 25,
  'text/plain': 10,
  'text/csv': 10
};

function displayStatus(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [activeView, setActiveView] = useState('Overview');
  const [question, setQuestion] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploadState, setUploadState] = useState({ status: 'idle', progress: 0, message: '' });
  const [isDragging, setIsDragging] = useState(false);
  const [extractingId, setExtractingId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reportState, setReportState] = useState({ status: 'idle', message: '' });
  const [documentFilter, setDocumentFilter] = useState('all');
  const [documentSearch, setDocumentSearch] = useState('');
  const [documentSort, setDocumentSort] = useState('recent');
  const [messages, setMessages] = useState([]);
  const fileInputRef = useRef(null);
  const [documents, setDocuments] = useState([]);

  const visibleDocuments = documents
    .filter((document) => document.name.toLowerCase().includes(documentSearch.toLowerCase()))
    .filter((document) => documentFilter === 'all' || document.status.toLowerCase() === documentFilter)
    .sort((left, right) => documentSort === 'name' ? left.name.localeCompare(right.name) : 0);

  function navigateTo(item) {
    setActiveView(item);
    const targetId = item === 'Documents' ? 'document-library' : item === 'Reports' ? 'report-section' : item === 'Knowledge Base' ? 'search-section' : item === 'Settings' ? 'requirements-section' : 'overview-section';
    document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  useEffect(() => {
    apiFetch(`${API_BASE}/api/health`)
      .then((res) => res.json())
      .then((data) => setHealth(data))
      .catch(() => setHealth({ status: 'offline' }));

    apiFetch(`${API_BASE}/api/documents`)
      .then((res) => res.json())
      .then((data) => {
        if (data.documents?.length) setDocuments(data.documents.map((document) => ({ ...document, status: displayStatus(document.status) })));
      })
      .catch(() => {});
  }, []);

  async function handleExtract(documentId) {
    setExtractingId(documentId);
    setDocuments((currentDocuments) => currentDocuments.map((document) => (
      document.id === documentId ? { ...document, status: 'Extracting' } : document
    )));

    try {
      const response = await apiFetch(`${API_BASE}/api/documents/${documentId}/extract`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Text extraction failed');
      setDocuments((currentDocuments) => currentDocuments.map((document) => (
        document.id === documentId ? { ...document, ...data.document, status: displayStatus(data.document.status) } : document
      )));
    } catch (error) {
      setDocuments((currentDocuments) => currentDocuments.map((document) => (
        document.id === documentId ? { ...document, status: 'Failed', error: error.message } : document
      )));
    } finally {
      setExtractingId(null);
    }
  }

  async function handleOcr(documentId) {
    setExtractingId(documentId);
    setDocuments((currentDocuments) => currentDocuments.map((document) => (
      document.id === documentId ? { ...document, status: 'Extracting' } : document
    )));

    try {
      const response = await apiFetch(`${API_BASE}/api/documents/${documentId}/ocr`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'OCR failed');
      setDocuments((currentDocuments) => currentDocuments.map((document) => (
        document.id === documentId ? { ...document, ...data.document, status: displayStatus(data.document.status) } : document
      )));
    } catch (error) {
      setDocuments((currentDocuments) => currentDocuments.map((document) => (
        document.id === documentId ? { ...document, status: 'Failed', error: error.message } : document
      )));
    } finally {
      setExtractingId(null);
    }
  }

  async function handleIndex(documentId) {
    setExtractingId(documentId);
    setDocuments((currentDocuments) => currentDocuments.map((document) => (
      document.id === documentId ? { ...document, status: 'Indexing' } : document
    )));

    try {
      const response = await apiFetch(`${API_BASE}/api/documents/${documentId}/index`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Embedding generation failed');
      setDocuments((currentDocuments) => currentDocuments.map((document) => (
        document.id === documentId ? { ...document, ...data.document, status: displayStatus(data.document.status) } : document
      )));
    } catch (error) {
      setDocuments((currentDocuments) => currentDocuments.map((document) => (
        document.id === documentId ? { ...document, status: 'Failed', error: error.message } : document
      )));
    } finally {
      setExtractingId(null);
    }
  }

  async function handleSearch(event) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setSearching(true);
    try {
      const response = await apiFetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 5 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Search failed');
      setSearchResults(data.results);
    } catch (error) {
      setSearchResults([{ chunkId: 'error', text: error.message, score: 0 }]);
    } finally {
      setSearching(false);
    }
  }

  async function handleGenerateReport() {
    setReportState({ status: 'generating', message: 'Generating report...' });
    try {
      const response = await apiFetch(`${API_BASE}/api/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Document intelligence findings', documentIds: documents.filter((document) => document.id.toString().startsWith('doc_')).map((document) => document.id) })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Report generation failed');
      setReportState({ status: 'success', message: 'Report ready for download.', downloadUrl: `${API_BASE}${data.downloadUrl}` });
    } catch (error) {
      setReportState({ status: 'error', message: error.message });
    }
  }

  async function processFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    setUploadError('');
    setUploadState({ status: 'uploading', progress: 20, message: `Validating ${files.length} document${files.length === 1 ? '' : 's'}...` });

    const invalidFile = files.find((file) => {
      const maxSizeMb = supportedFileTypes[file.type];
      return !maxSizeMb || file.size > maxSizeMb * 1024 * 1024;
    });

    if (invalidFile) {
      const maxSizeMb = supportedFileTypes[invalidFile.type];
      setUploadError(maxSizeMb
        ? `${invalidFile.name} exceeds the ${maxSizeMb} MB limit.`
        : `${invalidFile.name} is not a supported document type.`);
      setUploadState({ status: 'error', progress: 0, message: 'Upload failed. Review the file requirements and try again.' });
      return;
    }

    setUploadState({ status: 'uploading', progress: 45, message: `Uploading ${files.length} document${files.length === 1 ? '' : 's'}...` });

    try {
      const uploadedDocuments = [];
      for (const [index, file] of files.entries()) {
        const formData = new FormData();
        formData.append('file', file);
        const response = await apiFetch(`${API_BASE}/api/documents`, { method: 'POST', body: formData });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Unable to upload ${file.name}`);
        uploadedDocuments.push({ ...data.document, status: 'Queued' });
        setUploadState({
          status: 'uploading',
          progress: 45 + Math.round(((index + 1) / files.length) * 50),
          message: `Uploaded ${index + 1} of ${files.length} document${files.length === 1 ? '' : 's'}...`
        });
      }
      setDocuments((currentDocuments) => [...uploadedDocuments, ...currentDocuments]);
      setUploadState({ status: 'success', progress: 100, message: `${files.length} document${files.length === 1 ? '' : 's'} ready for processing.` });
    } catch (error) {
      setUploadState({ status: 'error', progress: 0, message: error.message });
      setUploadError('The server could not save this upload. No document was added to the library.');
    }
  }

  function handleFiles(event) {
    processFiles(event.target.files);
    event.target.value = '';
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    processFiles(event.dataTransfer.files);
  }

  async function handleAsk(event) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;

    setMessages((currentMessages) => [...currentMessages, { id: `${Date.now()}-question`, type: 'user', text: trimmedQuestion }]);
    setQuestion('');
    setAsking(true);
    try {
      const response = await apiFetch(`${API_BASE}/api/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmedQuestion })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Question failed');
      setMessages((currentMessages) => [...currentMessages, { id: data.id, type: 'assistant', text: data.answer, citations: data.citations, noEvidence: data.status === 'no_evidence' }]);
    } catch (error) {
      setMessages((currentMessages) => [...currentMessages, { id: `${Date.now()}-error`, type: 'assistant', text: `Unable to answer this question: ${error.message}` }]);
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">AMPLIFY AI</div>
        <nav>
          {['Overview', 'Documents', 'Knowledge Base', 'Reports', 'Settings'].map((item) => (
            <button
              className={`nav-item ${activeView === item ? 'active' : ''}`}
              key={item}
              onClick={() => navigateTo(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">AI consultancy PoC</p>
            <h1>Document Intelligence Workspace</h1>
          </div>
          <div className={`status ${health?.status === 'ok' ? 'online' : 'offline'}`}>
            {health?.status === 'ok' ? 'System online' : 'Backend offline'}
          </div>
        </header>

        <section className="overview-grid" id="overview-section">
          <div className="metric-card">
            <span>Total docs</span>
            <strong>{documents.length}</strong>
          </div>
          <div className="metric-card">
            <span>Questions answered</span>
            <strong>{messages.filter((message) => message.type === 'assistant').length}</strong>
          </div>
          <div className="metric-card">
            <span>Reports generated</span>
            <strong>{reportState.status === 'success' ? 1 : 0}</strong>
          </div>
          <div className="metric-card">
            <span>Accuracy score</span>
            <strong>{documents.filter((document) => document.embeddingStatus === 'indexed').length ? 'Indexed' : 'Pending'}</strong>
          </div>
        </section>

        <section className="content-grid">
          <div className="panel" id="document-library">
            <div className="panel-header">
              <h2>Document library</h2>
              <button className="primary-button" onClick={() => fileInputRef.current?.click()} type="button">Upload</button>
              <input
                accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt,.csv"
                className="visually-hidden"
                multiple
                onChange={handleFiles}
                ref={fileInputRef}
                type="file"
              />
            </div>
            <div className="document-toolbar">
              <input onChange={(event) => setDocumentSearch(event.target.value)} placeholder="Search documents..." value={documentSearch} />
              <select aria-label="Filter documents" onChange={(event) => setDocumentFilter(event.target.value)} value={documentFilter}>
                <option value="all">All statuses</option>
                <option value="uploaded">Uploaded</option>
                <option value="extracting">Extracting</option>
                <option value="extracted">Extracted</option>
                <option value="ready">Ready</option>
                <option value="failed">Failed</option>
              </select>
              <select aria-label="Sort documents" onChange={(event) => setDocumentSort(event.target.value)} value={documentSort}>
                <option value="recent">Recent</option>
                <option value="name">Name</option>
              </select>
            </div>
            <div
              className={`upload-dropzone ${isDragging ? 'dragging' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={(event) => { event.preventDefault(); setIsDragging(false); }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click(); }}
              role="button"
              tabIndex="0"
            >
              <strong>Drop documents here</strong>
              <span>or choose files to begin processing</span>
            </div>
            {uploadState.status !== 'idle' && (
              <div className={`upload-feedback ${uploadState.status}`}>
                <div className="upload-feedback-header">
                  <span>{uploadState.message}</span>
                  {uploadState.status === 'uploading' && <strong>{uploadState.progress}%</strong>}
                </div>
                {uploadState.status === 'uploading' && (
                  <div className="progress-track"><span style={{ width: `${uploadState.progress}%` }} /></div>
                )}
              </div>
            )}
            {uploadError && <p className="error-message">{uploadError}</p>}
            <ul className="doc-list">
              {visibleDocuments.map((doc) => (
                <li key={doc.id}>
                  <span className="document-name">{doc.name}</span>
                  <span className="document-actions">
                    {doc.chunkCount > 0 && <span className="chunk-count">{doc.chunkCount} chunk{doc.chunkCount === 1 ? '' : 's'}</span>}
                    <span className={`doc-status ${doc.status.toLowerCase()}`}>{doc.status}</span>
                    {doc.id.toString().startsWith('doc_') && doc.embeddingStatus !== 'indexed' && (
                      doc.status === 'Extracted'
                        ? <button className="extract-button" disabled={extractingId === doc.id} onClick={() => handleIndex(doc.id)} type="button">{extractingId === doc.id ? 'Indexing...' : 'Index embeddings'}</button>
                        : ['Ready', 'Queued', 'Uploaded', 'Failed'].includes(doc.status) && (doc.mimeType === 'image/png' || doc.mimeType === 'image/jpeg'
                          ? <button className="extract-button" disabled={extractingId === doc.id} onClick={() => handleOcr(doc.id)} type="button">{extractingId === doc.id ? 'Running OCR...' : 'Run OCR'}</button>
                          : <button className="extract-button" disabled={extractingId === doc.id} onClick={() => handleExtract(doc.id)} type="button">{extractingId === doc.id ? 'Extracting...' : 'Extract text'}</button>)
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {visibleDocuments.length === 0 && <p className="chat-empty">No documents match the current filters.</p>}
          </div>

          <div className="panel chat-panel" id="search-section">
            <div className="panel-header">
              <h2>Ask about documents</h2>
            </div>
            <div className="chat-box">
              {messages.length === 0 && <p className="chat-empty">Ask a question to search your indexed documents.</p>}
              {messages.map((message) => (
                <div className={`chat-message ${message.type} ${message.noEvidence ? 'no-evidence' : ''}`} key={message.id}>
                  <span>{message.text}</span>
                  {message.citations?.length > 0 && (
                    <div className="citation-list">
                      {message.citations.map((citation) => (
                        <details key={citation.chunkId}>
                          <summary>{citation.documentName}, p. {citation.pageNumber}</summary>
                          <small>{citation.excerpt} (relevance {citation.relevanceScore})</small>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {asking && <div className="chat-message assistant loading-message">Searching indexed documents...</div>}
            </div>
            <form className="chat-input-row" onSubmit={handleAsk}>
              <input disabled={asking} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question about your documents..." value={question} />
              <button className="primary-button" disabled={asking || !question.trim()} type="submit">{asking ? 'Searching...' : 'Ask'}</button>
            </form>
          </div>
        </section>

        <section className="panel search-panel">
          <div className="panel-header">
            <div>
              <p className="section-kicker">Day 10 retrieval quality</p>
              <h2>Search indexed evidence</h2>
            </div>
            <span className="contract-status">Semantic index</span>
          </div>
          <form className="search-form" onSubmit={handleSearch}>
            <input onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search across indexed documents..." value={searchQuery} />
            <button className="primary-button" disabled={searching} type="submit">{searching ? 'Searching...' : 'Search'}</button>
          </form>
          {searchResults.length > 0 && (
            <ul className="search-results">
              {searchResults.map((result) => (
                <li key={result.chunkId}>
                  <div><strong>{result.text}</strong><span>Page {result.pageNumber || 1}</span></div>
                  <small>Relevance {result.score}</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="requirements-panel panel" id="requirements-section">
          <div className="panel-header">
            <div>
              <p className="section-kicker">Day 2 complete</p>
              <h2>Requirements and data model</h2>
            </div>
            <span className="contract-status">Defined</span>
          </div>
          <div className="requirements-grid">
            <div className="requirement-block">
              <h3>Supported documents</h3>
              <ul className="format-list">
                {supportedFormats.map((item) => (
                  <li key={item.format}>
                    <span>{item.format}</span>
                    <strong>{item.limit}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div className="requirement-block">
              <h3>Processing stages</h3>
              <ol className="stage-list">
                {processingStages.map((stage, index) => (
                  <li key={stage}>
                    <span className="stage-number">{index + 1}</span>
                    {stage}
                  </li>
                ))}
              </ol>
            </div>
            <div className="requirement-block workflow-block">
              <h3>First end-to-end workflow</h3>
              <ol className="workflow-list">
                {workflowSteps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            </div>
          </div>
        </section>

        <section className="panel report-panel" id="report-section">
          <div className="panel-header">
            <div>
              <p className="section-kicker">Day 14 report generation</p>
              <h2>Export findings</h2>
            </div>
            <button className="primary-button" disabled={reportState.status === 'generating'} onClick={handleGenerateReport} type="button">{reportState.status === 'generating' ? 'Generating...' : 'Generate report'}</button>
          </div>
          {reportState.message && <div className={`report-status ${reportState.status}`}>{reportState.message}{reportState.downloadUrl && <a href={reportState.downloadUrl}> Download Markdown report</a>}</div>}
        </section>
      </main>
    </div>
  );
}
