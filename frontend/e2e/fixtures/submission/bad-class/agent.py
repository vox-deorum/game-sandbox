# Passes the static check (the manifest is well-formed and agent.py exists) but fails the sandboxed
# load check: the manifest names class `Ghost`, which this module does not define, so the load stage
# rejects with class_not_found while every earlier stage passes.
class Agent:
    def reset(self, seed):
        self.seed = seed

    def act(self, observation):
        return 0
