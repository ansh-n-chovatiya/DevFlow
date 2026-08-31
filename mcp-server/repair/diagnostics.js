export function traceDiagnostics(errorStack, flow) {
  // Parses a stack trace and attempts to correlate it with the ARKG causal DAG from the flow
  const stackLines = errorStack.split('\\n');
  const topFrame = stackLines.find(line => line.includes('.ts') || line.includes('.js') || line.includes('.tsx') || line.includes('.jsx'));
  
  const result = {
    originalError: errorStack,
    topFrame: topFrame || null,
    causalEventId: null,
    suspectedComponent: null,
  };

  // Find corresponding step in the flow if possible
  for (const step of flow.steps) {
    if (step.consoleLogs) {
      const errorLog = step.consoleLogs.find(l => l.level === 'error' && l.args.join(' ').includes(errorStack.substring(0, 50)));
      if (errorLog) {
        result.causalEventId = step.causedBy || null;
        result.suspectedComponent = step.element?.react?.owner || null;
        break;
      }
    }
  }

  return result;
}
