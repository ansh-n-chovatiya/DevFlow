export function explainFeature(description, flow) {
  // Traces implementation path from a natural language query
  const keywords = description.toLowerCase().split(' ');
  
  let explanation = `## Feature Explanation: ${description}\n\n`;
  explanation += `Based on the recorded interaction flow and ARKG components:\n\n`;
  
  const relevantSteps = flow.steps.filter(s => {
    return keywords.some(k => 
      (s.action && s.action.toLowerCase().includes(k)) ||
      (s.element?.text && s.element.text.toLowerCase().includes(k))
    );
  });
  
  if (relevantSteps.length === 0) {
    explanation += `No components directly related to "${description}" were found in this flow. Try recording a flow where this feature is used.`;
    return explanation;
  }
  
  explanation += `### Implementation Trace:\n\n`;
  
  for (const step of relevantSteps) {
    const component = step.element?.react?.owner || 'Unknown Component';
    explanation += `- **Action:** ${step.action}\n`;
    explanation += `  - **Component:** ${component}\n`;
    if (step.networkCalls && step.networkCalls.length > 0) {
      step.networkCalls.forEach(call => {
        explanation += `  - **API Route:** \`${call.method} ${call.url}\`\n`;
      });
    }
  }
  
  explanation += `\n### Summary:\n`;
  explanation += `The feature is primarily driven by the \`${relevantSteps[0].element?.react?.owner || 'entry'}\` component, making network requests to fetch or submit data related to the feature.`;
  
  return explanation;
}
