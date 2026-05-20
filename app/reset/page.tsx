'use client';

export default function ResetPage() {
  const clearAll = () => {
    localStorage.removeItem('chatSessions');
    localStorage.removeItem('gatewayConfig');
    alert('Cleared! Redirecting...');
    window.location.href = '/';
  };

  const clearSessions = () => {
    localStorage.removeItem('chatSessions');
    alert('Chat sessions cleared! Redirecting...');
    window.location.href = '/';
  };

  return (
    <div className="min-h-screen bg-black text-green-400 font-mono flex items-center justify-center">
      <div className="text-center space-y-6">
        <h1 className="text-2xl">Mission Control Reset</h1>
        <p className="text-gray-500">If the chat is crashing, clear the data:</p>
        <div className="space-x-4">
          <button 
            onClick={clearSessions}
            className="px-6 py-3 bg-yellow-500/20 border border-yellow-500 rounded hover:bg-yellow-500/30"
          >
            Clear Chat Sessions
          </button>
          <button 
            onClick={clearAll}
            className="px-6 py-3 bg-red-500/20 border border-red-500 rounded hover:bg-red-500/30"
          >
            Clear All Data
          </button>
        </div>
      </div>
    </div>
  );
}
