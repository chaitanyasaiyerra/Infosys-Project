import { GoogleGenAI, Type } from "@google/genai";
import { marked } from "marked";

// --- Types & Constants ---
const AppState = {
  IDLE: 'IDLE',
  PLANNING: 'PLANNING',
  LEARNING: 'LEARNING',
  QUIZ_GENERATION: 'QUIZ_GENERATION',
  QUIZ: 'QUIZ',
  RESULT: 'RESULT',
  FEYNMAN: 'FEYNMAN',
  COMPLETE: 'COMPLETE'
} as const;

type AppStateValue = typeof AppState[keyof typeof AppState];

interface Checkpoint {
  id: number;
  title: string;
  objective: string;
  status: 'current' | 'locked' | 'completed';
}

interface QuizQuestion {
  question: string;
  options: string[];
  correctOptionIndex: number;
}

interface QuizResult {
  score: number;
  passed: boolean;
  feedback: string;
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const MODEL_NAME = 'gemini-3-flash-preview';

const STATIC_FEEDBACK = {
  passed: [
    "Excellent mastery! You've clearly grasped these concepts.",
    "Great job! You're ready to move on to the next challenge.",
    "Perfect understanding. Your learning trajectory is looking solid.",
    "Well done! You have successfully cleared this checkpoint."
  ],
  failed: [
    "A few gaps were detected. Let's try to refine your understanding.",
    "Not quite there yet. The Feynman simplification might help clear things up.",
    "Reviewing the material one more time will help solidify these concepts.",
    "You're close! A quick review and you'll have this mastered."
  ]
};

// --- Application Logic ---
class FeynmanTutor {
  state: AppStateValue;
  topic: string;
  userNotes: string;
  checkpoints: Checkpoint[];
  currentIndex: number;
  currentContent: string;
  currentQuiz: QuizQuestion[];
  quizResult: QuizResult | null;
  loadingMessage: string;
  isMobileMenuOpen: boolean;
  sessionId: number;
  root: HTMLElement | null;
  loadingInterval: any;

  constructor() {
    this.state = AppState.IDLE;
    this.topic = '';
    this.userNotes = '';
    this.checkpoints = [];
    this.currentIndex = 0;
    this.currentContent = '';
    this.currentQuiz = [];
    this.quizResult = null;
    this.loadingMessage = 'Initializing Agent...';
    this.isMobileMenuOpen = false;
    this.sessionId = 0;

    this.root = document.getElementById('app-root');
    this.render();
  }

  // --- API Methods ---
  async generateLearningPath() {
    const prompt = `Create a structured learning path for the topic: "${this.topic}". 
    Context: ${this.userNotes.slice(0, 500)}.
    Break into 3-5 sequential checkpoints with "title" and "objective".`;

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              objective: { type: Type.STRING },
            },
            required: ["title", "objective"],
          },
        },
      },
    });

    const data = JSON.parse(response.text || "[]");
    this.checkpoints = data.map((item: any, index: number) => ({
      id: index,
      title: item.title,
      objective: item.objective,
      status: index === 0 ? 'current' : 'locked'
    }));
  }

  async generateContent(isFeynman = false) {
    const modeInstruction = isFeynman 
      ? "ACTIVATE FEYNMAN MODE: Explain like I am 12, use simple analogies, avoid jargon. Use tables where appropriate for data comparison. Keep it concise but thorough." 
      : "STANDARD ACADEMIC: Professional, structured, comprehensive explanation. Use tables for summary comparisons where helpful.";

    const prompt = `TOPIC: ${this.topic}, CHECKPOINT: ${this.checkpoints[this.currentIndex].title}, OBJECTIVE: ${this.checkpoints[this.currentIndex].objective}. ${modeInstruction} Synthesize the core concepts into well-formatted Markdown.`;

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt
    });

    this.currentContent = response.text || "No content generated.";
  }

  async generateQuiz() {
    const prompt = `Create 3 multiple-choice questions for this content: "${this.currentContent.slice(0, 2000)}".`;
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              options: { type: Type.ARRAY, items: { type: Type.STRING } },
              correctOptionIndex: { type: Type.INTEGER },
            },
            required: ["question", "options", "correctOptionIndex"],
          },
        },
      },
    });
    this.currentQuiz = JSON.parse(response.text || "[]");
  }

  // --- Handlers ---
  async handleStartLearning() {
    const tInput = document.getElementById('topic-input') as HTMLInputElement | null;
    const nInput = document.getElementById('notes-input') as HTMLTextAreaElement | null;
    if (!tInput?.value.trim()) return;

    this.topic = tInput.value;
    this.userNotes = nInput?.value || '';
    this.setState(AppState.PLANNING);

    try {
      await this.generateLearningPath();
      await this.loadCheckpoint(0);
    } catch (e) {
      console.error(e);
      alert("Error generating path.");
      this.setState(AppState.IDLE);
    }
  }

  async loadCheckpoint(index: number, isFeynman = false) {
    this.currentIndex = index;
    this.setState(isFeynman ? AppState.FEYNMAN : AppState.LEARNING);
    this.quizResult = null;
    this.currentContent = '';
    
    this.startLoadingSimulation();
    try {
      await this.generateContent(isFeynman);
      this.stopLoadingSimulation();
      this.render();
    } catch (e) {
      alert("Content generation failed.");
      this.setState(AppState.IDLE);
    }
  }

  async handleStartQuiz() {
    this.setState(AppState.QUIZ_GENERATION);
    try {
      await this.generateQuiz();
      this.setState(AppState.QUIZ);
    } catch (e) {
      alert("Quiz generation failed.");
      this.setState(AppState.LEARNING);
    }
  }

  handleSubmitQuiz() {
    const answers: number[] = [];
    this.currentQuiz.forEach((_, i) => {
      const selected = document.querySelector(`input[name="q-${i}"]:checked`) as HTMLInputElement | null;
      if (selected) {
        answers.push(parseInt(selected.value));
      }
    });

    if (answers.length < this.currentQuiz.length) {
      alert("Please answer all questions before submitting.");
      return;
    }

    // INSTANT EVALUATION
    let correct = 0;
    this.currentQuiz.forEach((q, i) => {
      if (q.correctOptionIndex === answers[i]) {
        correct++;
      }
    });

    const score = Math.round((correct / this.currentQuiz.length) * 100);
    const passed = score >= 70;

    const feedbacks = passed ? STATIC_FEEDBACK.passed : STATIC_FEEDBACK.failed;
    const feedback = feedbacks[Math.floor(Math.random() * feedbacks.length)];

    this.quizResult = { score, passed, feedback };
    
    this.setState(AppState.RESULT);
  }

  handleNextCheckpoint() {
    this.checkpoints[this.currentIndex].status = 'completed';
    const nextIdx = this.currentIndex + 1;
    if (nextIdx < this.checkpoints.length) {
      this.checkpoints[nextIdx].status = 'current';
      this.loadCheckpoint(nextIdx);
    } else {
      this.setState(AppState.COMPLETE);
    }
  }

  // --- UI Helpers ---
  setState(newState: AppStateValue) {
    this.state = newState;
    this.render();
  }

  startLoadingSimulation() {
    const messages = ["Analyzing Concepts...", "Synthesizing Knowledge...", "Constructing Modules..."];
    let i = 0;
    this.loadingInterval = setInterval(() => {
      this.loadingMessage = messages[i % messages.length];
      i++;
      const msgEl = document.getElementById('loading-msg');
      if (msgEl) msgEl.innerText = this.loadingMessage;
    }, 1500);
  }

  stopLoadingSimulation() {
    clearInterval(this.loadingInterval);
  }

  // --- Rendering ---
  render() {
    if (this.state === AppState.IDLE || this.state === AppState.PLANNING) {
      this.renderLanding();
    } else {
      this.renderAppShell();
    }
  }

  renderLanding() {
    const isPlanning = this.state === AppState.PLANNING;
    if (this.root) {
      this.root.innerHTML = `
        <div class="min-h-screen bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 flex flex-col items-center justify-center p-6 relative overflow-hidden">
          <div class="absolute top-0 -left-4 w-72 h-72 bg-purple-300 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob"></div>
          <div class="absolute top-0 -right-4 w-72 h-72 bg-indigo-300 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob" style="animation-delay: 2s"></div>
          <div class="max-w-2xl w-full bg-white/60 backdrop-blur-xl rounded-3xl shadow-2xl border border-white/50 p-12 relative z-10 fade-in">
            <div class="text-center mb-10">
              <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 mb-6 shadow-lg shadow-violet-500/30">
                 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-8 h-8 text-white"><path stroke-linecap="round" stroke-linejoin="round" d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.57 50.57 0 0 0-2.658-.813A59.905 59.905 0 0 1 12 3.493a59.902 59.902 0 0 1 10.499 5.24 50.552 50.552 0 0 0-2.658.813m-15.482 0A50.55 50.55 0 0 1 12 13.489a50.55 50.55 0 0 1 12-4.155" /></svg>
              </div>
              <h1 class="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 mb-4">Feynman AI Tutor</h1>
              <p class="text-lg text-slate-600">Master any subject through autonomous pathways and adaptive <span class="font-semibold text-violet-600">Feynman simplification</span>.</p>
            </div>
            <div class="space-y-6">
              <div>
                <label class="block text-xs font-bold text-slate-700 mb-2 uppercase tracking-widest">Topic of Study</label>
                <input id="topic-input" type="text" value="${this.topic}" placeholder="e.g. Quantum Computing" class="w-full px-5 py-4 rounded-xl border border-slate-200 focus:ring-4 focus:ring-violet-500/10 outline-none transition-all" ${isPlanning ? 'disabled' : ''}>
              </div>
              <div>
                <label class="block text-xs font-bold text-slate-700 mb-2 uppercase tracking-widest">Context Notes (Optional)</label>
                <textarea id="notes-input" placeholder="Paste notes here..." class="w-full px-5 py-4 rounded-xl border border-slate-200 focus:ring-4 focus:ring-violet-500/10 outline-none transition-all h-32 resize-none" ${isPlanning ? 'disabled' : ''}>${this.userNotes}</textarea>
              </div>
              <button id="start-btn" class="w-full bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:scale-[1.02] text-white font-bold py-4 rounded-xl shadow-xl transition-all flex items-center justify-center gap-3" ${isPlanning ? 'disabled' : ''}>
                ${isPlanning ? '<div class="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div> Planning...' : 'Initialize Learning Agent'}
              </button>
            </div>
          </div>
        </div>
      `;
    }

    document.getElementById('start-btn')?.addEventListener('click', () => this.handleStartLearning());
  }

  renderAppShell() {
    if (this.root) {
      this.root.innerHTML = `
        <div class="flex h-screen bg-[#f8fafc] overflow-hidden">
          <!-- Sidebar -->
          <aside class="w-80 bg-white border-r border-slate-200 hidden md:flex flex-col shadow-sm">
            <div class="p-8 border-b border-slate-100">
              <h2 class="text-2xl font-extrabold text-indigo-600 flex items-center gap-3">
                <div class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-sm font-bold">F</div>
                Pathfinder
              </h2>
            </div>
            <div class="flex-1 overflow-y-auto p-6 space-y-6">
              ${this.checkpoints.map((cp) => `
                <div class="relative pl-8 border-l-2 ${cp.status === 'completed' ? 'border-green-500' : 'border-slate-100'}">
                  <div class="absolute -left-[9px] top-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${cp.status === 'completed' ? 'bg-green-500 border-green-500' : (cp.status === 'current' ? 'bg-white border-violet-500 shadow-md' : 'bg-slate-100 border-slate-200')}">
                    ${cp.status === 'completed' ? '<svg class="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7" /></svg>' : ''}
                  </div>
                  <h3 class="text-sm font-bold ${cp.status === 'current' ? 'text-violet-700' : 'text-slate-700'}">${cp.title}</h3>
                  <p class="text-[10px] text-slate-400 mt-1">${cp.objective}</p>
                </div>
              `).join('')}
            </div>
            <div class="p-4 border-t border-slate-100 bg-slate-50">
               <button id="home-btn" class="w-full flex items-center justify-center gap-2 py-2 text-slate-400 hover:text-red-500 text-xs font-bold transition-colors uppercase tracking-widest">
                 End Session
               </button>
            </div>
          </aside>

          <!-- Main Content -->
          <main class="flex-1 overflow-y-auto p-10 relative">
            <div class="max-w-4xl mx-auto">
              ${this.renderContent()}
            </div>
          </main>
        </div>
      `;
    }

    document.getElementById('home-btn')?.addEventListener('click', () => {
      this.state = AppState.IDLE;
      this.render();
    });
    this.attachEventListeners();
  }

  renderContent() {
    if (this.state === AppState.LEARNING || this.state === AppState.FEYNMAN) {
      if (!this.currentContent) {
        return `
          <div class="flex flex-col items-center justify-center h-[60vh] gap-6 fade-in">
            <div class="w-20 h-20 bg-violet-100 rounded-full flex items-center justify-center animate-pulse">
              <div class="w-12 h-12 border-4 border-violet-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
            <h3 class="text-xl font-bold text-slate-800" id="loading-msg">${this.loadingMessage}</h3>
          </div>
        `;
      }

      return `
        <div class="fade-in">
          <div class="mb-8">
            <span class="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest ${this.state === AppState.FEYNMAN ? 'bg-amber-100 text-amber-700' : 'bg-violet-100 text-violet-700'}">
              ${this.state === AppState.FEYNMAN ? 'Feynman Mode Active' : 'Standard Module'}
            </span>
            <h1 class="text-4xl font-extrabold text-slate-900 mt-4">${this.checkpoints[this.currentIndex].title}</h1>
          </div>
          <div class="bg-white rounded-[32px] shadow-sm p-10 prose-custom border border-slate-100">
            ${marked(this.currentContent)}
            
            <div class="mt-12 flex justify-end">
              <button id="start-quiz-btn" class="bg-slate-900 text-white px-10 py-4 rounded-2xl font-bold hover:bg-black transition-all shadow-xl shadow-slate-100">Verify Mastery</button>
            </div>
          </div>
        </div>
      `;
    }

    if (this.state === AppState.QUIZ || this.state === AppState.QUIZ_GENERATION) {
      if (this.state === AppState.QUIZ_GENERATION) {
        return `<div class="flex flex-col items-center justify-center h-[50vh]"><div class="animate-spin rounded-full h-10 w-10 border-4 border-violet-500 border-t-transparent mb-4"></div><p class="font-bold text-slate-400 uppercase tracking-widest text-[10px]">Generating Assessment...</p></div>`;
      }

      return `
        <div class="fade-in">
          <h2 class="text-3xl font-bold text-slate-800 mb-8">Checkpoint Verification</h2>
          <div class="space-y-6">
            ${this.currentQuiz.map((q, i) => `
              <div class="bg-white p-8 rounded-2xl shadow-sm border border-slate-100">
                <p class="text-lg font-bold text-slate-800 mb-5">${i + 1}. ${q.question}</p>
                <div class="space-y-2">
                  ${q.options.map((opt, oi) => `
                    <label class="flex items-center gap-3 p-4 border-2 border-slate-50 rounded-xl cursor-pointer hover:bg-slate-50 transition-all has-[:checked]:border-violet-500 has-[:checked]:bg-violet-50 group">
                      <input type="radio" name="q-${i}" value="${oi}" class="w-4 h-4 text-violet-600">
                      <span class="text-slate-700 font-medium group-hover:text-slate-900 transition-colors">${opt}</span>
                    </label>
                  `).join('')}
                </div>
              </div>
            `).join('')}
            <button id="submit-quiz-btn" class="w-full bg-slate-900 text-white py-4 rounded-xl font-bold text-lg hover:bg-black shadow-xl transition-all">Submit Evaluation</button>
          </div>
        </div>
      `;
    }

    if (this.state === AppState.RESULT && this.quizResult) {
      const r = this.quizResult;
      return `
        <div class="text-center py-12 fade-in bg-white rounded-[40px] shadow-sm border border-slate-100 px-10">
          <div class="w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl ${r.passed ? 'bg-green-500 shadow-green-100' : 'bg-amber-500 shadow-amber-100'}">
            <svg class="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="${r.passed ? 'M5 13l4 4L19 7' : 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'}" /></svg>
          </div>
          <h3 class="text-3xl font-black text-slate-900 mb-2">${r.passed ? 'Checkpoint Cleared' : 'Gap Detected'}</h3>
          <div class="mb-8">
            <span class="text-5xl font-black text-slate-200 tracking-tighter">${r.score}%</span>
          </div>
          <p class="text-lg text-slate-500 mb-10 max-w-lg mx-auto leading-relaxed">${r.feedback}</p>
          <div class="flex justify-center">
            ${r.passed 
              ? `<button id="next-cp-btn" class="bg-violet-600 text-white px-10 py-4 rounded-2xl font-bold shadow-xl hover:bg-violet-700 transition-all">Proceed to Next Module</button>`
              : `<button id="feynman-btn" class="bg-amber-500 text-white px-10 py-4 rounded-2xl font-bold shadow-xl hover:bg-amber-600 transition-all uppercase tracking-widest text-xs">Simpler Explanation (Feynman Technique)</button>`
            }
          </div>
        </div>
      `;
    }

    if (this.state === AppState.COMPLETE) {
      return `
        <div class="text-center py-20 fade-in bg-white rounded-[40px] shadow-sm border border-slate-100 px-10">
          <div class="w-24 h-24 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-8 animate-bounce shadow-2xl shadow-green-50">
            <svg class="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
          </div>
          <h2 class="text-4xl font-black text-slate-900 mb-4">Subject Mastered!</h2>
          <p class="text-slate-500 text-lg mb-10 max-w-sm mx-auto">You have completed the entire learning trajectory for <b>${this.topic}</b>.</p>
          <button onclick="window.location.reload()" class="bg-slate-900 text-white px-10 py-4 rounded-2xl font-bold hover:bg-black transition-all shadow-xl">New Trajectory</button>
        </div>
      `;
    }

    return ``;
  }

  attachEventListeners() {
    document.getElementById('start-quiz-btn')?.addEventListener('click', () => this.handleStartQuiz());
    document.getElementById('submit-quiz-btn')?.addEventListener('click', () => this.handleSubmitQuiz());
    document.getElementById('next-cp-btn')?.addEventListener('click', () => this.handleNextCheckpoint());
    document.getElementById('feynman-btn')?.addEventListener('click', () => this.loadCheckpoint(this.currentIndex, true));
  }
}

// Start the app
new FeynmanTutor();