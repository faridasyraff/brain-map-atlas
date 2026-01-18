import { useState } from 'react';

function AIprompt() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (!input.trim()) return;

    // Add user message
    const userMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');

    // Simulate AI response (replace with real API call later)
    setTimeout(() => {
      const aiResponse = { role: 'assistant', content: 'This is a mock AI response. Integrate with an AI API like OpenAI for real functionality.' };
      setMessages(prev => [...prev, aiResponse]);
    }, 1000);
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h1>AI Prompt</h1>
      <div style={{ border: '1px solid #ccc', height: '400px', overflowY: 'auto', padding: '10px', marginBottom: '10px' }}>
        {messages.map((msg, index) => (
          <div key={index} style={{ marginBottom: '10px', textAlign: msg.role === 'user' ? 'right' : 'left' }}>
            <div style={{
              display: 'inline-block',
              padding: '10px',
              borderRadius: '10px',
              backgroundColor: msg.role === 'user' ? '#007bff' : '#f1f1f1',
              color: msg.role === 'user' ? 'white' : 'black',
              maxWidth: '70%'
            }}>
              {msg.content}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Type your prompt..."
          style={{ flex: 1, padding: '10px', border: '1px solid #ccc', borderRadius: '5px' }}
        />
        <button onClick={handleSend} style={{ padding: '10px 20px', marginLeft: '10px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '5px' }}>
          Send
        </button>
      </div>
    </div>
  );
}

export default AIprompt;