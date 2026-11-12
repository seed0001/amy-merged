"""User-facing findings, including useful partial results at every stopping condition."""

import re


def _join(items):
    items=[item for item in items if item]
    if not items:return ''
    if len(items)==1:return items[0]
    if len(items)==2:return items[0]+' and '+items[1]
    return ', '.join(items[:-1])+', and '+items[-1]


def _normal(text):
    return re.sub(r'\s+',' ',str(text)).strip()


def final_summary(state,pick=None):
    """One flowing account of the whole investigation, written for the final report.

    Progress updates stay short and factual. This closing statement deliberately
    repeats the whole picture in prose so the listener gets a coherent answer
    rather than a second list of the same milestones.
    """
    topic=state.get('objective','this question').rstrip('?.')
    phase=state.get('phase')
    paragraphs=[]
    if phase=='complete':
        paragraphs.append('I have finished looking into '+topic+'.')
    elif phase=='limited':
        paragraphs.append('I reached the investigation work limit while looking into '+topic+', so this is a partial summary rather than a completed answer.')
    else:
        paragraphs.append('I have taken the investigation of '+topic+' as far as the available evidence allows.')

    definitions=state.get('definitions',[])
    phrase=[d for d in definitions if d.get('scope')=='phrase']
    choices=phrase or definitions
    if state.get('implementation'):
        target=state.get('target_term')
        choices=[d for d in choices if not target or d['term']==target][:1]
    choices=choices[:3]
    meanings=[];seen=set()
    for definition in choices:
        text=definition['definition'].rstrip('.')
        if text in seen:continue
        seen.add(text)
        if pick:
            from dialogue.investigation_wording import say
            line=say(pick,'meaning',term=definition['term'],definition=text)
            meanings.append(_normal(line or ('One dictionary meaning of "'+definition['term']+'" is '+text+'.')))
        else:
            meanings.append('One dictionary meaning of "'+definition['term']+'" is '+text+'.')
    if meanings:
        opening='' if len(meanings)==1 else 'I compared several recorded meanings. '
        paragraphs.append(opening+' '.join(meanings)
                          +' That describes a possible meaning; it does not by itself establish who or what satisfies it.')
    for check in state.get('definition_checks',[]):
        paragraphs.append(_normal(check['text']))
    if state.get('implementation') and state.get('definition_checks'):
        used={key for check in state['definition_checks'] for key in check['observations']}
        observed=[item for item in state['implementation'] if item['id'] in used]
        for item in observed:
            paragraphs.append('The runtime observation from '+item['source']+' is that it '+item['relation']+' '+str(item['value'])+'.')

    evidence=state.get('evidence',[])
    if evidence:
        claims=[e['text'].rstrip('.')+' (from '+str(e.get('source') or 'an unspecified source')+')' for e in evidence[:3]]
        paragraphs.append('The recorded evidence I drew on includes '+_join(claims)+'.')

    supported=[c for c in state.get('conclusions',[]) if c.get('status') in ('yes','no')]
    conflicting=[c for c in state.get('conclusions',[]) if c.get('status')=='conflicting']
    if supported:
        conclusion=supported[0]
        paragraphs.append('The conclusion I can support is that '+conclusion['text'].rstrip('.')+'.')
        if conclusion.get('supporting_facts'):
            paragraphs.append('That follows from '+_join([fact.rstrip('.') for fact in conclusion['supporting_facts']])+'.')
    elif conflicting:
        paragraphs.append('The recorded evidence supports opposing answers, so I cannot settle the question yet.')
    else:
        paragraphs.append('I did not establish a supported answer to the question itself.')

    for connection in state.get('connections',[])[:3]:
        paragraphs.append('An established rule also connects these facts: '+connection['text'].rstrip('.')+'.')
    for hypothesis in state.get('hypotheses',[])[:3]:
        status=hypothesis.get('status')
        if status=='rejected':
            counter=hypothesis.get('counterexamples',[])
            why=counter[0].get('explanation') if counter else None
            paragraphs.append('I rejected the proposal that '+hypothesis['label'][:1].lower()+hypothesis['label'][1:]
                              +((' because '+why.rstrip('.')) if why else ' because its evidence checks did not hold')+'.')
        elif status=='provisional-supported':
            paragraphs.append('The proposal that '+hypothesis['label'][:1].lower()+hypothesis['label'][1:]
                              +' survived the checked cases, but it remains provisional rather than a general fact.')
        elif status=='insufficient-evidence':
            paragraphs.append('The proposal that '+hypothesis['label'][:1].lower()+hypothesis['label'][1:]
                              +' remains unconfirmed because the checked evidence is insufficient.')
    mechanism=state.get('mechanisms')
    if mechanism:
        values=_join([name+'='+str(round(value,3)) for name,value in mechanism.get('state_variables',{}).items()
                      if isinstance(value,(int,float))])
        if values:
            if pick:
                from dialogue.investigation_wording import say
                paragraphs.append(_normal(say(pick,'state',values=values) or ('My current state readings are '+values+'.')))
            else:
                paragraphs.append('My current state readings are '+values+'.')
    research=state.get('research') or {}
    if research.get('learned'):
        sources=research.get('sources') or []
        learned=len(research['learned'])
        sentence='I also checked public sources'
        if sources:
            sentence+=' including '+_join(sources[:2])
        sentence+=' and retained '+str(learned)+' newly corroborated fact'+('s' if learned!=1 else '')+' from them.'
        paragraphs.append(sentence)

    gaps=state.get('gaps',[])
    if gaps:
        question=gaps[0]['question'].strip()
        if not question.endswith(('?','!','.')):question+='.'
        paragraphs.append('The remaining question is this: '+question)
    if phase=='limited':
        paragraphs.append('Because I stopped at the investigation work limit, these are partial findings rather than a completed answer.')
    elif phase=='waiting':
        paragraphs.append('I have reached the available evidence limit, so I need the missing evidence or criteria before drawing a stronger conclusion.')
    elif phase=='complete':
        paragraphs.append('That is the whole picture the evidence supports; nothing beyond it was added.')
    elif not state.get('conclusions'):
        paragraphs.append('I cannot yet establish an answer to the original question from these findings.')
    return '\n\n'.join(paragraphs)


def findings(state,pick=None):
    """Render committed evidence, never turn lexical candidates into proven facts."""
    parts=[]
    for conclusion in state.get('conclusions',[]):
        if conclusion.get('text') and conclusion.get('status') in ('yes','no'):
            parts.append('The evidence supports '+conclusion['text'].rstrip('.')+'.')
            if conclusion.get('supporting_facts'):
                parts.append('That follows from '+ '; '.join(conclusion['supporting_facts'])+'.')
        elif conclusion.get('status')=='conflicting':
            parts.append('The recorded evidence supports opposing answers, so I cannot settle the question yet.')
    definitions=state.get('definitions',[])
    phrase=[d for d in definitions if d.get('scope')=='phrase']
    choices=phrase or definitions
    if state.get('implementation'):
        target=state.get('target_term')
        choices=[d for d in choices if not target or d['term']==target][:1]
    seen=set()
    for definition in choices:
        text=definition['definition'].rstrip('.')
        if text in seen:continue
        seen.add(text)
        if pick:
            from dialogue.investigation_wording import say
            line=say(pick,'meaning',term=definition['term'],definition=text)
            parts.append(line or '"'+definition['term']+'": '+text+'.')
        else:
            parts.append('One dictionary meaning of "'+definition['term']+'" is '+text+'.')
    if choices:
        parts.append('That describes a possible meaning; it does not by itself establish who satisfies it.')
    for check in state.get('definition_checks',[]):
        parts.append(check['text'])
    if state.get('implementation') and state.get('definition_checks'):
        used={key for check in state['definition_checks'] for key in check['observations']}
        observed=[item for item in state['implementation'] if item['id'] in used]
        for item in observed:
            parts.append('Runtime observation ('+item['source']+'): '+item['relation']+' '+str(item['value'])+'.')
    evidence=state.get('evidence',[])
    if evidence:
        parts.append('The relevant recorded claims include '+ '; '.join(
            e['text'].rstrip('.')+' (from '+str(e.get('source') or 'an unspecified source')+')' for e in evidence[:3])+'.')
    for connection in state.get('connections',[])[:3]:
        parts.append('An established rule connects these facts: '+connection['text'].rstrip('.')+'.')
    for hypothesis in state.get('hypotheses',[])[:3]:
        status=hypothesis.get('status')
        if status=='rejected':
            counter=hypothesis.get('counterexamples',[])
            why=counter[0].get('explanation') if counter else None
            parts.append('I rejected the proposal "'+hypothesis['label']+'"'+(' because '+why.rstrip('.') if why else ' because its evidence checks did not hold')+'.')
        elif status=='provisional-supported':
            parts.append('The pattern "'+hypothesis['label']+'" survived the checked cases, but remains provisional rather than a general fact.')
        elif status=='insufficient-evidence':
            parts.append('The proposal "'+hypothesis['label']+'" remains unconfirmed; the checked evidence is insufficient.')
    mechanism=state.get('mechanisms')
    if mechanism:
        values=', '.join(name+'='+str(round(value,3)) for name,value in mechanism.get('state_variables',{}).items()
                        if isinstance(value,(int,float)))
        if pick:
            from dialogue.investigation_wording import say
            line=say(pick,'state',values=values)
            parts.append(line or values+'.')
        else:parts.append('My current state readings are '+values+'.')
    if not parts:
        parts.append('I have not established a supported finding for this question yet.')
    gaps=state.get('gaps',[])
    if gaps:
        parts.append('What remains unresolved: '+gaps[0]['question'])
    elif not state.get('conclusions') and state.get('phase') in ('waiting','limited'):
        parts.append('I cannot yet establish an answer to the original question from these findings.')
    if state.get('phase')=='limited':
        parts.append('I stopped at the investigation work limit. These are partial findings, not a completed answer.')
    elif state.get('phase')=='waiting':
        parts.append('I have reached the available evidence limit, so I need the missing evidence or criteria before drawing a stronger conclusion.')
    return '\n\n'.join(parts)
